import { formatLocalRange } from './time.ts';

type Numeric = number | null | undefined;

export function buildBookingConfirmationText({
  windowStartIso,
  windowEndIso,
  address,
  timeZone,
  lowEstimate,
  highEstimate,
}: {
  windowStartIso: string;
  windowEndIso: string;
  address: string;
  timeZone: string;
  lowEstimate?: Numeric;
  highEstimate?: Numeric;
}): string {
  const label = formatLocalRange(
    timeZone,
    new Date(windowStartIso),
    new Date(windowEndIso),
  );
  const estimate = buildEstimateRange(lowEstimate, highEstimate);
  const safeAddress = address.trim().length > 0 ? address.trim() : 'the address we have on file';
  return `Locked in for ${label} at ${safeAddress}. Estimate ${estimate} based on what we discussed. Final price confirmed onsite after we see weight/access. We’ll text 20 min before arrival. Thanks for choosing Stonegate!`;
}

function buildEstimateRange(low?: Numeric, high?: Numeric): string {
  const l = typeof low === 'number' && Number.isFinite(low) ? low : null;
  const h = typeof high === 'number' && Number.isFinite(high) ? high : null;
  if (l !== null && h !== null) {
    return `${formatCurrency(l)}–${formatCurrency(h)}`;
  }
  if (h !== null) {
    return formatCurrency(h);
  }
  return 'the range we discussed';
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(Math.round(value));
}
