// Template token rendering. Supported tokens:
//   {{firstName}} {{lastName}} {{email}} {{unsubscribeUrl}}
// Unknown tokens are left in place (so typos are visible, not silent).

export interface RenderContext {
  firstName?: string | null;
  lastName?: string | null;
  email: string;
  unsubscribeUrl: string;
}

export function renderTemplate(template: string, ctx: RenderContext): string {
  const values: Record<string, string> = {
    firstName: ctx.firstName ?? "",
    lastName: ctx.lastName ?? "",
    email: ctx.email,
    unsubscribeUrl: ctx.unsubscribeUrl,
  };
  return template.replace(/\{\{\s*([a-zA-Z]+)\s*\}\}/g, (match, name: string) => {
    return Object.prototype.hasOwnProperty.call(values, name) ? values[name] : match;
  });
}
