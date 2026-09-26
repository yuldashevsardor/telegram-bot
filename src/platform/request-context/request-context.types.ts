// The keys of the values of the current update. Only RequestContext.getValues() hands the values
// to the log, so a value under a key missing from this list never reaches it.
// as const is required: the store type is derived from here. Without it a typo in a key would
// compile, and correlation would be lost silently.
export const REQUEST_KEYS = {
    REQUEST_ID: "requestId",
} as const;

export type RequestKey = (typeof REQUEST_KEYS)[keyof typeof REQUEST_KEYS];

// The values stay unknown: the store is shared, and the reading side narrows the type to its needs.
export type RequestStore = Partial<Record<RequestKey, unknown>>;
