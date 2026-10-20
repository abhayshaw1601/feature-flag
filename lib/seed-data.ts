import type { FlagSummary, FlagType, RuleSet } from "@flagforge/contracts";

export const demoWorkspace = {
  id: "workspace_northstar",
  name: "Northstar Labs",
  slug: "northstar-labs",
};

export const demoProjects = [
  { id: "project_checkout", name: "Checkout Platform", key: "checkout" },
  { id: "project_growth", name: "Growth Lab", key: "growth" },
] as const;

export const demoEnvironments = [
  { id: "env_development", name: "Development", key: "development" },
  { id: "env_staging", name: "Staging", key: "staging" },
  { id: "env_production", name: "Production", key: "production" },
] as const;

export const demoOwners = [
  { id: "user_priya", name: "Priya Shah" },
  { id: "user_mateo", name: "Mateo Ruiz" },
  { id: "user_lin", name: "Lin Chen" },
  { id: "user_noor", name: "Noor Patel" },
] as const;

const baseDate = new Date("2026-10-20T12:00:00.000Z");

const defaultRules: RuleSet = {
  rules: [],
  defaultServe: { rolloutPercent: 100 },
};

const indiaProRule: RuleSet = {
  rules: [
    {
      id: "rule_india_pro",
      description: "India users on the pro plan",
      conditions: [
        { attribute: "country", operator: "equals", values: ["IN"] },
        { attribute: "plan", operator: "equals", values: ["pro"] },
      ],
      serve: { rolloutPercent: 100 },
    },
  ],
  defaultServe: { rolloutPercent: 0 },
};

type Definition = {
  key: string;
  name: string;
  type: FlagType;
  description: string;
  tags: string[];
  owner: (typeof demoOwners)[number] | null;
  rollout: [number, number, number];
  archived?: boolean;
  rules?: RuleSet;
  ageDays: number;
};

export const seedDefinitions: Definition[] = [
  {
    key: "checkout_refresh",
    name: "Checkout refresh",
    type: "RELEASE",
    description: "Updated checkout layout for returning customers.",
    tags: ["checkout", "frontend"],
    owner: demoOwners[0],
    rollout: [100, 25, 0],
    ageDays: 2,
  },
  {
    key: "billing_portal_v2",
    name: "Billing portal v2",
    type: "RELEASE",
    description: "New self-serve billing history and invoice controls.",
    tags: ["billing"],
    owner: demoOwners[1],
    rollout: [100, 100, 10],
    ageDays: 4,
  },
  {
    key: "search_facets",
    name: "Search facets",
    type: "RELEASE",
    description: "Filters for narrowing the catalog search results.",
    tags: ["search", "catalog"],
    owner: demoOwners[2],
    rollout: [100, 100, 100],
    ageDays: 7,
  },
  {
    key: "payment_retry_guard",
    name: "Payment retry guard",
    type: "OPS",
    description: "Stops duplicate retry attempts after a processor timeout.",
    tags: ["payments", "safety"],
    owner: demoOwners[0],
    rollout: [100, 100, 0],
    ageDays: 1,
    rules: indiaProRule,
  },
  {
    key: "invoice_pdf_export",
    name: "Invoice PDF export",
    type: "PERMISSION",
    description: "Allows finance users to download invoice PDFs.",
    tags: ["billing", "permissions"],
    owner: demoOwners[3],
    rollout: [100, 0, 0],
    ageDays: 9,
  },
  {
    key: "product_recommendations",
    name: "Product recommendations",
    type: "EXPERIMENT",
    description: "Compares related-product ranking strategies on the cart page.",
    tags: ["experiment", "cart"],
    owner: demoOwners[2],
    rollout: [100, 50, 20],
    ageDays: 5,
    rules: defaultRules,
  },
  {
    key: "new_tax_engine",
    name: "New tax engine",
    type: "RELEASE",
    description: "Calculates regional taxes with the updated jurisdiction map.",
    tags: ["tax", "checkout"],
    owner: demoOwners[0],
    rollout: [100, 10, 0],
    ageDays: 3,
  },
  {
    key: "fraud_review_queue",
    name: "Fraud review queue",
    type: "OPS",
    description: "Routes high-risk orders into the manual review queue.",
    tags: ["fraud", "operations"],
    owner: demoOwners[1],
    rollout: [100, 100, 25],
    ageDays: 6,
  },
  {
    key: "mobile_navigation_v3",
    name: "Mobile navigation v3",
    type: "RELEASE",
    description: "Reorganized navigation for smaller screens.",
    tags: ["mobile", "frontend"],
    owner: demoOwners[2],
    rollout: [100, 100, 100],
    ageDays: 11,
  },
  {
    key: "customer_notes",
    name: "Customer notes",
    type: "PERMISSION",
    description: "Lets support agents add internal notes to customer records.",
    tags: ["support", "permissions"],
    owner: demoOwners[3],
    rollout: [100, 50, 0],
    ageDays: 12,
  },
  {
    key: "subscription_pause",
    name: "Subscription pause",
    type: "RELEASE",
    description: "Adds a pause option to subscription management.",
    tags: ["subscriptions"],
    owner: demoOwners[0],
    rollout: [100, 100, 5],
    ageDays: 8,
  },
  {
    key: "order_history_v2",
    name: "Order history v2",
    type: "RELEASE",
    description: "Refreshes order history with shipment milestones.",
    tags: ["orders"],
    owner: demoOwners[1],
    rollout: [100, 75, 25],
    ageDays: 10,
  },
  {
    key: "warehouse_routing",
    name: "Warehouse routing",
    type: "OPS",
    description: "Chooses a fulfillment warehouse before payment capture.",
    tags: ["operations", "fulfillment"],
    owner: demoOwners[2],
    rollout: [100, 100, 80],
    ageDays: 13,
  },
  {
    key: "regional_pricing",
    name: "Regional pricing",
    type: "PERMISSION",
    description: "Enables regional price books for approved storefronts.",
    tags: ["pricing", "permissions"],
    owner: null,
    rollout: [100, 30, 0],
    ageDays: 17,
  },
  {
    key: "smart_search",
    name: "Smart search",
    type: "EXPERIMENT",
    description: "Tests typo-tolerant search ranking on catalog queries.",
    tags: ["experiment", "search"],
    owner: demoOwners[3],
    rollout: [100, 50, 10],
    ageDays: 14,
    rules: defaultRules,
  },
  {
    key: "refund_reason_codes",
    name: "Refund reason codes",
    type: "RELEASE",
    description: "Standardizes the reason captured for each refund.",
    tags: ["payments", "support"],
    owner: demoOwners[0],
    rollout: [100, 100, 100],
    ageDays: 19,
  },
  {
    key: "one_click_reorder",
    name: "One-click reorder",
    type: "RELEASE",
    description: "Adds a reorder action for recently purchased items.",
    tags: ["orders", "retention"],
    owner: demoOwners[1],
    rollout: [100, 20, 0],
    ageDays: 22,
  },
  {
    key: "invoice_reminders",
    name: "Invoice reminders",
    type: "OPS",
    description: "Sends a reminder when an invoice is nearing its due date.",
    tags: ["billing", "automation"],
    owner: demoOwners[2],
    rollout: [100, 100, 100],
    ageDays: 25,
  },
  {
    key: "partner_api_v2",
    name: "Partner API v2",
    type: "PERMISSION",
    description: "Allows approved partners to use the version 2 API surface.",
    tags: ["api", "partners"],
    owner: null,
    rollout: [100, 10, 0],
    ageDays: 28,
  },
  {
    key: "checkout_observability",
    name: "Checkout observability",
    type: "OPS",
    description: "Adds structured timing events around checkout steps.",
    tags: ["observability", "checkout"],
    owner: demoOwners[0],
    rollout: [100, 100, 100],
    ageDays: 31,
  },
  {
    key: "gift_card_balance",
    name: "Gift card balance",
    type: "RELEASE",
    description: "Shows a balance preview before a gift card is applied.",
    tags: ["payments", "gift-cards"],
    owner: demoOwners[3],
    rollout: [100, 75, 30],
    ageDays: 34,
  },
  {
    key: "returns_portal_v2",
    name: "Returns portal v2",
    type: "RELEASE",
    description: "Guides customers through return eligibility and labels.",
    tags: ["returns", "support"],
    owner: demoOwners[1],
    rollout: [100, 40, 0],
    ageDays: 37,
  },
  {
    key: "address_validation_v2",
    name: "Address validation v2",
    type: "OPS",
    description: "Validates delivery addresses against the latest provider API.",
    tags: ["shipping", "safety"],
    owner: demoOwners[2],
    rollout: [100, 100, 50],
    ageDays: 41,
  },
  {
    key: "loyalty_tiers",
    name: "Loyalty tiers",
    type: "EXPERIMENT",
    description: "Tests a tiered loyalty benefit summary at checkout.",
    tags: ["experiment", "loyalty"],
    owner: null,
    rollout: [100, 25, 5],
    ageDays: 46,
  },
  {
    key: "legacy_checkout",
    name: "Legacy checkout",
    type: "RELEASE",
    description: "Legacy checkout path kept for rollback coverage during migration.",
    tags: ["legacy", "checkout"],
    owner: demoOwners[0],
    rollout: [0, 0, 0],
    ageDays: 72,
    archived: true,
  },
];

function isoDaysAgo(days: number) {
  const date = new Date(baseDate);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString();
}

export function buildFlagSummary(definition: Definition, index: number): FlagSummary {
  return {
    id: `flag_${String(index + 1).padStart(3, "0")}`,
    projectId: demoProjects[0].id,
    key: definition.key,
    name: definition.name,
    description: definition.description,
    type: definition.type,
    tags: definition.tags,
    owner: definition.owner,
    archivedAt: definition.archived ? isoDaysAgo(2) : null,
    createdAt: isoDaysAgo(definition.ageDays + 18),
    updatedAt: isoDaysAgo(definition.ageDays),
    environments: demoEnvironments.map((environment, environmentIndex) => {
      const rolloutPercent = definition.rollout[environmentIndex];
      const enabled = rolloutPercent > 0;
      return {
        environmentId: environment.id,
        environmentKey: environment.key,
        enabled,
        rules: definition.rules ?? { ...defaultRules, defaultServe: { rolloutPercent } },
        rolloutPercent,
        offValue: false,
        onValue: true,
        version: Math.max(1, 12 - definition.ageDays + environmentIndex),
        updatedAt: isoDaysAgo(Math.max(0, definition.ageDays - environmentIndex)),
      };
    }),
  };
}

export const demoFlags = seedDefinitions.map(buildFlagSummary);

export function flagStatus(flag: FlagSummary, environmentKey: string) {
  const environment = flag.environments.find((item) => item.environmentKey === environmentKey);
  if (!environment || !environment.enabled || environment.rolloutPercent === 0) return "Off";
  if (environment.rolloutPercent === 100) return "On";
  return "Partial rollout";
}
