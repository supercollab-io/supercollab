// Unit tests use real encryption, SQLite, and MCP but do not download models.
export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@huggingface/transformers') {
    return { url: new URL('./embeddings.mjs', import.meta.url).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
