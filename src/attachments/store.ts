/** Artifact store de anexos de imagem (ADR-0026, #392): raiz validada, hash e GC. */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { canonicalize, isWithin } from "../tools/paths";
import { AttachmentError, MAX_ATTACHMENT_BYTES } from "./model";

export interface ResolveArtifactRootInput {
  /** `--artifact-root` (maior precedência). */
  flag?: string | undefined;
  env?: NodeJS.ProcessEnv;
  astroHome: string;
}

export interface ArtifactValidationContext {
  cwd: string;
  astroHome: string;
  protectedPaths?: readonly string[];
  /** Checagem de privacidade injetável (teste); ausente usa modo/ACL da plataforma. */
  checkPrivate?: (path: string) => boolean;
}

export interface ArtifactOwner {
  sessionId?: string;
  runId: string;
  /** Linhagem de sessões retomadas (ADR-0010). */
  lineage?: readonly string[];
}

export interface ArtifactStoreOptions extends ArtifactValidationContext {
  ttlDays?: number;
  maxBytes?: number;
  now?: () => number;
}

export interface StoredArtifact {
  ref: string;
  hash: string;
  bytes: number;
}

interface ArtifactMeta {
  schema: "artifact/v1";
  ref: string;
  hash: string;
  bytes: number;
  mediaType: string;
  sessionId?: string;
  runId: string;
  lineage?: readonly string[];
  createdAt: string;
}

const REF_PATTERN = /^(?:session|run)-[a-f0-9]{64}\/[a-f0-9]{64}$/;
const KEY_PATTERN = /^(?:session|run)-[a-f0-9]{64}$/;
const DEFAULT_TTL_DAYS = 7;
const DEFAULT_MAX_BYTES = 1024 ** 3;

function fold(path: string): string {
  return process.platform === "win32" || process.platform === "darwin" ? path.toLowerCase() : path;
}

function expandHome(input: string): string {
  const match = /^~([^\\/]*)([\\/][\s\S]*)?$/.exec(input);
  if (!match) return input;
  if (match[1] === "") return match[2] ? join(homedir(), match[2].slice(1)) : homedir();
  const info = userInfo();
  if (match[1] !== info.username) return input; // `~outro` não resolve; validação rejeita relativo
  return join(info.homedir, match[2]?.slice(1) ?? "");
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Raiz efetiva: flag > env (vazio/só espaços = ausente) > `$ASTRO_HOME/attachments`. */
export function resolveArtifactRoot(input: ResolveArtifactRootInput): string {
  const flag = input.flag?.trim();
  if (flag !== undefined && flag !== "") return expandHome(flag);
  const env = input.env?.ASTRO_ARTIFACT_ROOT?.trim();
  if (env !== undefined && env !== "") return expandHome(env);
  return join(input.astroHome, "attachments");
}

/** Privacidade default: 0700 no POSIX; ACL explícita no Windows fica para a fatia de wiring. */
function defaultCheckPrivate(path: string): boolean {
  if (process.platform === "win32") return true;
  try {
    return (statSync(path).mode & 0o077) === 0;
  } catch (error) {
    // Raiz ainda não criada: o construtor cria com 0700 logo após validar.
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

/** Valida a raiz antes de qualquer escrita/reidratação; falha tipada, nunca relaxa. */
export function validateArtifactRoot(root: string, context: ArtifactValidationContext): void {
  const expanded = expandHome(root);
  if (!isAbsolute(expanded)) {
    throw new AttachmentError("attachment_root_invalid", `raiz de artefato precisa ser absoluta: ${root}`);
  }
  const real = canonicalize(expanded);
  const astroHome = canonicalize(context.astroHome);
  const cwd = canonicalize(context.cwd);
  const folded = fold(real);

  if (folded === fold(astroHome)) {
    throw new AttachmentError("attachment_root_invalid", "raiz de artefato não pode ser o próprio ASTRO_HOME");
  }
  if (isWithin(fold(cwd), folded) || isWithin(folded, fold(cwd))) {
    throw new AttachmentError("attachment_root_invalid", `raiz de artefato precisa ficar fora do cwd: ${real}`);
  }
  if (existsSync(join(real, ".git"))) {
    throw new AttachmentError("attachment_root_invalid", `raiz de artefato não pode ser worktree git: ${real}`);
  }
  const statePaths = [
    join(astroHome, "vault.json"),
    join(astroHome, "providers.json"),
    join(astroHome, "trusted.json"),
    join(astroHome, "state.json"),
    join(astroHome, "sessions"),
    join(astroHome, "ledger.jsonl"),
    join(astroHome, "audit.jsonl"),
    join(cwd, ".astro"),
    join(cwd, ".git"),
    ...(context.protectedPaths ?? []).map((path) => (isAbsolute(path) ? path : join(cwd, path))),
  ];
  if (statePaths.some((path) => isWithin(fold(canonicalize(path)), folded) || isWithin(folded, fold(canonicalize(path))))) {
    throw new AttachmentError("attachment_root_invalid", `raiz de artefato conflita com estado do harness: ${real}`);
  }
  const checkPrivate = context.checkPrivate ?? defaultCheckPrivate;
  if (!checkPrivate(real)) {
    throw new AttachmentError("attachment_root_invalid", `raiz de artefato precisa ser privada (0700/ACL): ${real}`);
  }
}

function ownerKey(owner: ArtifactOwner): string {
  return owner.sessionId === undefined
    ? `run-${sha256(Buffer.from(`run\u0000${owner.runId}`, "utf8"))}`
    : `session-${sha256(Buffer.from(`session\u0000${owner.sessionId}`, "utf8"))}`;
}

/** Store de artefatos: valida a raiz na construção e revalida cada ref na leitura. */
export class ArtifactStore {
  readonly root: string;
  readonly #context: ArtifactValidationContext;
  readonly #ttlMs: number;
  readonly #maxBytes: number;
  readonly #now: () => number;

  constructor(root: string, options: ArtifactStoreOptions) {
    const { cwd, astroHome, protectedPaths, checkPrivate } = options;
    this.#context = {
      cwd,
      astroHome,
      ...(protectedPaths === undefined ? {} : { protectedPaths }),
      ...(checkPrivate === undefined ? {} : { checkPrivate }),
    };
    try {
      validateArtifactRoot(root, this.#context);
      this.root = canonicalize(expandHome(root));
      mkdirSync(this.root, { recursive: true, mode: 0o700 });
    } catch (error) {
      throw error instanceof AttachmentError ? error : new AttachmentError("attachment_root_invalid", `não foi possível preparar a raiz de artefato: ${error instanceof Error ? error.message : String(error)}`, root);
    }
    this.#ttlMs = (options.ttlDays ?? DEFAULT_TTL_DAYS) * 24 * 60 * 60 * 1000;
    this.#maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.#now = options.now ?? Date.now;
  }

  /** Bytes já usados por artefatos do harness. */
  usageBytes(): number {
    let total = 0;
    for (const key of this.#keys()) {
      for (const name of readdirSync(join(this.root, key))) {
        if (!/^[a-f0-9]{64}$/.test(name)) continue;
        total += statSync(join(this.root, key, name)).size;
      }
    }
    return total;
  }

  /** Grava os bytes e o metadado; recusa acima do teto do store. */
  save(owner: ArtifactOwner, bytes: Uint8Array, mediaType: string): StoredArtifact {
    if (bytes.length > MAX_ATTACHMENT_BYTES) {
      throw new AttachmentError("attachment_too_large", `artefato excede ${MAX_ATTACHMENT_BYTES} bytes`);
    }
    if (this.usageBytes() + bytes.length > this.#maxBytes) {
      throw new AttachmentError("attachment_too_large", `artifact store atingiu o teto de ${this.#maxBytes} bytes`);
    }
    const key = ownerKey(owner);
    const hash = sha256(bytes);
    const dir = join(this.root, key);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, hash), bytes, { mode: 0o600 });
    const ref = `${key}/${hash}`;
    const meta: ArtifactMeta = {
      schema: "artifact/v1",
      ref,
      hash,
      bytes: bytes.length,
      mediaType,
      ...(owner.sessionId === undefined ? {} : { sessionId: owner.sessionId }),
      runId: owner.runId,
      ...(owner.lineage === undefined ? {} : { lineage: owner.lineage }),
      createdAt: new Date(this.#now()).toISOString(),
    };
    writeFileSync(join(dir, `${hash}.json`), JSON.stringify(meta), { mode: 0o600 });
    return { ref, hash, bytes: bytes.length };
  }

  /** Lê e valida o hash; ref ausente/adulterado falha tipado. */
  read(ref: string): Uint8Array {
    if (!REF_PATTERN.test(ref)) {
      throw new AttachmentError("attachment_image_invalid", `ref de artefato inválido: ${ref}`);
    }
    const [key, hash] = ref.split("/") as [string, string];
    const path = join(this.root, key, hash);
    const rel = relative(this.root, path);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new AttachmentError("attachment_image_invalid", `ref fora da raiz de artefato: ${ref}`);
    }
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(readFileSync(path));
    } catch {
      throw new AttachmentError("attachment_image_invalid", `artefato ausente ou expirado: ${ref}`);
    }
    if (sha256(bytes) !== hash) {
      throw new AttachmentError("attachment_image_invalid", `hash do artefato divergente: ${ref}`);
    }
    return bytes;
  }

  /** Remove artefatos expirados do harness; nunca o ref atual nem arquivo alheio. */
  gc(currentRefs: readonly string[] = []): string[] {
    const keep = new Set(currentRefs);
    const removed: string[] = [];
    const cutoff = this.#now() - this.#ttlMs;
    for (const key of this.#keys()) {
      const dir = join(this.root, key);
      for (const name of readdirSync(dir)) {
        if (!/^[a-f0-9]{64}$/.test(name)) continue;
        const ref = `${key}/${name}`;
        if (keep.has(ref)) continue;
        const metaPath = join(dir, `${name}.json`);
        let meta: Partial<ArtifactMeta>;
        try {
          meta = JSON.parse(readFileSync(metaPath, "utf8")) as Partial<ArtifactMeta>;
        } catch {
          continue; // sem metadado do harness: não é nosso
        }
        if (meta.schema !== "artifact/v1" || meta.ref !== ref) continue;
        if (statSync(join(dir, name)).mtimeMs >= cutoff) continue;
        unlinkSync(join(dir, name));
        unlinkSync(metaPath);
        removed.push(ref);
      }
    }
    return removed;
  }

  #keys(): string[] {
    try {
      return readdirSync(this.root).filter((name) => KEY_PATTERN.test(name));
    } catch {
      return [];
    }
  }
}
