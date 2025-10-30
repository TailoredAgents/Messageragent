import { describe, expect, it } from 'vitest';

import { computeQuote } from '../price-engine.js';
import { VisionFeatureSummary } from '../types.js';

const pricebook = {
  trailer: { cubic_yards: 16.6, label: '16-yard trailer' },
  min_job: 149,
  curbside_min_job: 99,
  curbside_discount_pct: 10,
  volume_tiers: [
    { name: 'minimum', yd3: 1.5, full_service: 149 },
    { name: '1/8', yd3: 2.1, full_service: 199 },
    { name: '1/4', yd3: 4.1, full_service: 299 },
    { name: '3/8', yd3: 6.2, full_service: 389 },
    { name: '1/2', yd3: 8.3, full_service: 429 },
    { name: '5/8', yd3: 10.4, full_service: 474 },
    { name: '3/4', yd3: 12.4, full_service: 549 },
    { name: '7/8', yd3: 14.5, full_service: 609 },
    { name: 'full', yd3: 16.6, full_service: 649 },
  ],
  weight_policy: {
    included_full_load_lb: 2000,
    overage_step_lb: 500,
    overage_price_per_step: 50,
  },
  bedload: {
    concrete_brick_tile: { rate_per_cy: 250, max_cy_per_trip: 2 },
    dirt_soil_rocks: { rate_per_cy: 150, max_cy_per_trip: 3 },
    roofing_shingles: { rate_per_cy: 225, max_cy_per_trip: 3 },
  },
  surcharges: {
    stairs_per_flight: 25,
    long_carry_per_50ft: 25,
    extra_labor_per_quarter_hour_per_person: 20,
    same_day_priority: 50,
    tight_window_priority: 50,
  },
  regulated_items: {
    mattress: 20,
    appliance_freon: 20,
    flat_screen_tv: 20,
    paint_gallon: 5,
    paint_5gal: 15,
  },
  contamination_fee: 60,
} as const;

const serviceArea = {
  mode: 'radius_plus_counties' as const,
  center: { lat: 34.1016, lng: -84.5194 },
  radius_miles: 30,
  allowed_counties: ['Cobb', 'Cherokee', 'Fulton'],
  travel_baseline_miles: 20,
  travel_excess_rate_per_mile: 2.5,
};

const quotePolicy = {
  disclaimer:
    'Estimate pending onsite confirmation. Weight/regulated items may affect final price.',
  auto_approve_cap: 600,
  hazard_keywords: ['needles', 'chemicals', 'paint spill', 'asbestos', 'biohazard'],
};

const baseLead = {
  curbside: false,
  lat: 34.1016,
  lng: -84.5194,
  address: '123 Test Lane',
};

describe('computeQuote', () => {
  it('calculates volume tier and surcharges deterministically', () => {
    const features: VisionFeatureSummary = {
      volume_class: '1/4',
      cubic_yards_est: 3.0,
      bedload: false,
      bedload_type: null,
      heavy_items: ['mattress'],
      stairs_flights: 1,
      carry_distance_ft: 40,
      curbside: false,
      hazards: [],
      confidence: 0.92,
    };

    const result = computeQuote({
      features,
      pricebook,
      serviceArea,
      quotePolicy,
      lead: baseLead,
    });

    expect(result.line_items).toEqual([
      { label: '1/4 load (4.1 yd³)', amount: 299 },
      { label: 'Stairs surcharge (1 flights)', amount: 25 },
      { label: 'Regulated item: mattress', amount: 20 },
    ]);
    expect(result.discounts).toEqual([]);
    expect(result.subtotal).toBe(344);
    expect(result.total).toBe(344);
    expect(result.flags.needs_approval).toBe(false);
    expect(result.flags.low_confidence).toBe(false);
  });

  it('applies curbside discount but honors curbside minimum', () => {
    const features: VisionFeatureSummary = {
      volume_class: '1/8',
      cubic_yards_est: 2.0,
      bedload: false,
      bedload_type: null,
      heavy_items: [],
      stairs_flights: 0,
      carry_distance_ft: 30,
      curbside: true,
      hazards: [],
      confidence: 0.85,
    };

    const result = computeQuote({
      features,
      pricebook,
      serviceArea,
      quotePolicy,
      lead: { ...baseLead, curbside: true },
    });

    expect(result.subtotal).toBe(199);
    expect(result.discounts[0].label).toContain('Curbside discount');
    expect(result.total).toBeCloseTo(179.1, 2);
    expect(result.total).toBeGreaterThanOrEqual(pricebook.curbside_min_job);
  });

  it('flags hazards and auto approval requirements', () => {
    const features: VisionFeatureSummary = {
      volume_class: '3/4',
      cubic_yards_est: 12.0,
      bedload: true,
      bedload_type: 'concrete_brick_tile',
      heavy_items: [],
      stairs_flights: 2,
      carry_distance_ft: 120,
      curbside: false,
      hazards: ['paint spill'],
      confidence: 0.55,
    };

    const result = computeQuote({
      features,
      pricebook,
      serviceArea,
      quotePolicy,
      lead: baseLead,
    });

    expect(result.flags.low_confidence).toBe(true);
    expect(result.flags.needs_approval).toBe(true);
    expect(result.notes.some((note) => note.toLowerCase().includes('hazard'))).toBe(true);
  });
});

