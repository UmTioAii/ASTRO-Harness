/**
 * Entropia de Shannon (ADR-0027, #391 slice 3b): base 2, bits por caractere,
 * calculada sobre as unidades de código UTF-16 do texto.
 *
 * Função pura, sem I/O e sem dependência. String vazia retorna 0 (definido,
 * não lança): conteúdo vazio não é segredo e não deve ser tratado como
 * "inconclusivo". Textos curtos retornam o valor exato ("a" -> 0,
 * "ab" -> 1). O limite teórico é log2(tamanho do alfabeto); conteúdo
 * byte-oriented (base64 ~6, hex ~4, aleatório ~8 no máximo por byte).
 */
export function shannonEntropyBitsPerChar(text: string): number {
  if (text.length === 0) return 0;
  const counts = new Map<number, number>();
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  const total = text.length;
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / total;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}
