export function calculateHeapUsagePercent(
  heapUsed: number,
  heapTotal: number,
  heapSizeLimit: number,
): number {
  const denominator = heapSizeLimit > 0 ? heapSizeLimit : heapTotal;
  if (denominator <= 0) {
    return 0;
  }

  return (heapUsed / denominator) * 100;
}
