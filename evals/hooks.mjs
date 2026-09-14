/** Fire every handler for an event, returning the last defined result. */
export async function fire(handlers, name, event, ctx) {
  let result;
  for (const handler of handlers.get(name) ?? []) {
    const value = await handler(event, ctx);
    if (value !== undefined) result = value;
  }
  return result;
}
