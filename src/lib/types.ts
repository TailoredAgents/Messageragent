export type VisionFeatureSummary = {
  volume_class: string;
  cubic_yards_est: number;
  bedload: boolean;
  bedload_type: string | null;
  heavy_items: string[];
  stairs_flights: number;
  carry_distance_ft: number;
  curbside: boolean;
  hazards: string[];
  confidence: number;
};

export type QuoteComputation = {
  line_items: Array<{ label: string; amount: number }>;
  discounts: Array<{ label: string; amount: number }>;
  subtotal: number;
  total: number;
  flags: {
    needs_approval: boolean;
    low_confidence: boolean;
    out_of_area: boolean;
  };
  notes: string[];
};

export type ProposedSlot = {
  id: string;
  label: string;
  window_start: string;
  window_end: string;
};

export type MessengerAttachment = {
  type: 'image' | 'file';
  url: string;
};

export type MessengerQuickReply = {
  title: string;
  payload: string;
};

export type ContextCandidate = {
  id: string;
  source: 'job' | 'lead';
  leadId?: string | null;
  jobId?: string | null;
  customerId?: string | null;
  addressId?: string | null;
  addressLine?: string | null;
  category?: string | null;
  summary: string;
  lastInteractionAt: Date;
  score: number;
};
