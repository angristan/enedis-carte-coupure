export function enterSpan(ctx, name, attributes, callback) {
  const tracing = ctx?.tracing;
  const run = async (span) => {
    setAttributes(span, attributes);
    return callback(span || noopSpan);
  };

  if (tracing?.enterSpan) {
    return tracing.enterSpan(name, run);
  }
  return run(noopSpan);
}

export function setAttributes(span, attributes = {}) {
  if (!span?.setAttribute) return;
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === null) continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      span.setAttribute(key, value);
    }
  }
}

const noopSpan = {
  isTraced: false,
  setAttribute() {},
};
