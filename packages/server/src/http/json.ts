// JSON for the API. Money is bigint micro-rupees everywhere; JSON numbers can't hold it exactly, so every bigint is
// written as its exact base-10 string (`priceMicro: "891972727"`). Clients format it for display (core formatINR).

export function toJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => (typeof item === 'bigint' ? item.toString() : item));
}

export function jsonResponse(value: unknown, status = 200): Response {
  return new Response(toJson(value), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}
