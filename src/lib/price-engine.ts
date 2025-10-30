import { VisionFeatureSummary, QuoteComputation } from './types.js';

type Pricebook = {
  trailer: { cubic_yards: number; label: string };
  min_job: number;
  curbside_min_job: number;
  curbside_discount_pct: number;
  volume_tiers: Array<{ name: string; yd3: number; full_service: number }>;
  weight_policy: {
    included_full_load_lb: number;
    overage_step_lb: number;
    overage_price_per_step: number;
  };
  bedload: Record<string, { rate_per_cy: number; max_cy_per_trip: number }>;
  surcharges: {
    stairs_per_flight: number;
    long_carry_per_50ft: number;
    extra_labor_per_quarter_hour_per_person: number;
    same_day_priority: number;
    tight_window_priority: number;
  };
  regulated_items: Record<string, number>;
  contamination_fee: number;
};

type ServiceArea = {
  mode: 'radius_plus_counties';
  center: { lat: number; lng: number };
  radius_miles: number;
  allowed_counties: string[];
  travel_baseline_miles: number;
  travel_excess_rate_per_mile: number;
};

type QuotePolicy = {
  disclaimer: string;
  auto_approve_cap: number;
  hazard_keywords: string[];
};

type ComputeQuoteInput = {
  features: VisionFeatureSummary;
  pricebook: Pricebook;
  serviceArea: ServiceArea;
  quotePolicy: QuotePolicy;
  lead: {
    curbside: boolean;
    lat?: number | null;
    lng?: number | null;
    address: string;
  };
};

const DEFAULT_LONG_CARRY_BASELINE_FT = 50;

const roundCurrency = (value: number): number => {
  return Math.round(value * 100) / 100;
};

const milesBetween = (
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number => {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const earthRadiusMiles = 3958.8;

  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);

  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);

  const haversine =
    sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLng * sinLng;
  const c = 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
  return earthRadiusMiles * c;
};

export function computeQuote({
  features,
  pricebook,
  serviceArea,
  quotePolicy,
  lead,
}: ComputeQuoteInput): QuoteComputation {
  const lineItems: QuoteComputation['line_items'] = [];
  const discounts: QuoteComputation['discounts'] = [];
  const notes: string[] = [];

  const flags: QuoteComputation['flags'] = {
    needs_approval: false,
    low_confidence: features.confidence < 0.7,
    out_of_area: false,
  };

  const applyApprovalFlag = (reason: string) => {
    flags.needs_approval = true;
    notes.push(reason);
  };

  let basePrice = 0;

  if (features.bedload) {
    if (!features.bedload_type) {
      applyApprovalFlag('Bedload detected but material type is unknown.');
    } else {
      const bedloadRule = pricebook.bedload[features.bedload_type];
      if (bedloadRule) {
        if (features.cubic_yards_est > bedloadRule.max_cy_per_trip) {
          applyApprovalFlag(
            `Bedload volume exceeds max of ${bedloadRule.max_cy_per_trip} cy.`,
          );
        }
        basePrice = roundCurrency(
          features.cubic_yards_est * bedloadRule.rate_per_cy,
        );
        lineItems.push({
          label: `Bedload (${features.bedload_type.replaceAll('_', ' ')})`,
          amount: basePrice,
        });
      } else {
        applyApprovalFlag(
          `Bedload type ${features.bedload_type} missing pricebook rule.`,
        );
      }
    }
  } else {
    const tiers = pricebook.volume_tiers.sort((a, b) => a.yd3 - b.yd3);
    const tier =
      tiers.find((t) => features.cubic_yards_est <= t.yd3) ?? tiers.at(-1);

    if (tier) {
      basePrice = tier.full_service;
      if (!features.curbside && basePrice < pricebook.min_job) {
        notes.push('Minimum full-service job pricing applied.');
        basePrice = pricebook.min_job;
      }
      lineItems.push({
        label: `${tier.name} load (${tier.yd3} yd³)`,
        amount: basePrice,
      });
      if (tier === tiers.at(-1) && features.cubic_yards_est > tier.yd3) {
        applyApprovalFlag(
          `Estimated volume ${features.cubic_yards_est} yd³ exceeds trailer capacity.`,
        );
      }
    } else {
      applyApprovalFlag('No matching volume tier found.');
    }
  }

  if (features.stairs_flights > 0) {
    const surcharge =
      pricebook.surcharges.stairs_per_flight * features.stairs_flights;
    lineItems.push({
      label: `Stairs surcharge (${features.stairs_flights} flights)`,
      amount: surcharge,
    });
  }

  if (features.carry_distance_ft > DEFAULT_LONG_CARRY_BASELINE_FT) {
    const extraDistance =
      features.carry_distance_ft - DEFAULT_LONG_CARRY_BASELINE_FT;
    const blocks = Math.ceil(extraDistance / 50);
    const surcharge =
      pricebook.surcharges.long_carry_per_50ft * Math.max(0, blocks);
    if (surcharge > 0) {
      lineItems.push({
        label: `Long carry surcharge (${features.carry_distance_ft} ft)`,
        amount: surcharge,
      });
    }
  }

  if (features.heavy_items.length > 0) {
    features.heavy_items.forEach((item) => {
      const key = item.toLowerCase().replaceAll(/\s+/g, '_');
      const surcharge = pricebook.regulated_items[key];
      if (surcharge) {
        lineItems.push({
          label: `Regulated item: ${item}`,
          amount: surcharge,
        });
      } else {
        notes.push(`Review regulated item "${item}" manually.`);
      }
    });
  }

  if (features.hazards.length > 0) {
    notes.push(`Hazards flagged: ${features.hazards.join(', ')}`);
    applyApprovalFlag('Hazard detected by vision analysis.');
    lineItems.push({
      label: 'Contamination mitigation',
      amount: pricebook.contamination_fee,
    });
  }

  // Travel surcharge calculations if we have coordinates.
  if (lead.lat != null && lead.lng != null) {
    const distance = milesBetween(
      { lat: lead.lat, lng: lead.lng },
      serviceArea.center,
    );
    if (distance > serviceArea.radius_miles) {
      flags.out_of_area = true;
      applyApprovalFlag(
        `Lead located ${distance.toFixed(1)} miles from yard (outside radius).`,
      );
    }

    if (distance > serviceArea.travel_baseline_miles) {
      const extraMiles = distance - serviceArea.travel_baseline_miles;
      const travelCharge = roundCurrency(
        extraMiles * serviceArea.travel_excess_rate_per_mile,
      );
      lineItems.push({
        label: `Travel overage (${extraMiles.toFixed(1)} mi)`,
        amount: travelCharge,
      });
    }
  }

  let subtotal = lineItems.reduce((sum, item) => sum + item.amount, 0);
  subtotal = roundCurrency(subtotal);

  const curbsideEligible = features.curbside || lead.curbside;
  if (curbsideEligible && subtotal > 0) {
    let discount = roundCurrency(
      (subtotal * pricebook.curbside_discount_pct) / 100,
    );
    const totalAfterDiscount = roundCurrency(subtotal - discount);
    if (totalAfterDiscount < pricebook.curbside_min_job) {
      discount = roundCurrency(subtotal - pricebook.curbside_min_job);
      if (discount < 0) {
        discount = 0;
      }
      notes.push('Curbside discount limited by curbside minimum job rate.');
    }
    if (discount > 0) {
      discounts.push({
        label: `Curbside discount (${pricebook.curbside_discount_pct}%)`,
        amount: -discount,
      });
    }
  }

  const total =
    subtotal +
    discounts.reduce((sum, item) => {
      return sum + item.amount;
    }, 0);

  if (total > quotePolicy.auto_approve_cap) {
    applyApprovalFlag(
      `Total ${total.toFixed(2)} exceeds auto-approve cap of $${quotePolicy.auto_approve_cap}.`,
    );
  }

  const hazardKeywordHit = features.hazards.some((hazard) =>
    quotePolicy.hazard_keywords.some(
      (keyword) =>
        hazard.toLowerCase().includes(keyword) ||
        keyword.toLowerCase().includes(hazard.toLowerCase()),
    ),
  );
  if (hazardKeywordHit) {
    applyApprovalFlag('Hazard keyword found in hazard list.');
  }

  if (flags.low_confidence) {
    notes.push(
      `Vision confidence ${features.confidence.toFixed(
        2,
      )} below threshold; recommend manual review.`,
    );
  }

  return {
    line_items: lineItems.map((item) => ({
      label: item.label,
      amount: roundCurrency(item.amount),
    })),
    discounts: discounts.map((item) => ({
      label: item.label,
      amount: roundCurrency(item.amount),
    })),
    subtotal: roundCurrency(subtotal),
    total: roundCurrency(total),
    flags,
    notes,
  };
}

