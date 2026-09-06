export const env = {};
export async function pipeline() {
  return async () => ({ data: new Float32Array(384).fill(1 / Math.sqrt(384)) });
}
