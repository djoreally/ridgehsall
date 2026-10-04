// Minimal CSV parser (RFC 4180-ish): handles quoted fields, escaped quotes,
// embedded commas/newlines, and CRLF. Keeps dependencies lean.

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;

  // Strip BOM
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          inQuotes = false;
          i++;
        }
      } else {
        field += ch;
        i++;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
        i++;
      } else if (ch === ",") {
        row.push(field);
        field = "";
        i++;
      } else if (ch === "\r") {
        i++;
      } else if (ch === "\n") {
        row.push(field);
        field = "";
        rows.push(row);
        row = [];
        i++;
      } else {
        field += ch;
        i++;
      }
    }
  }
  // trailing field / row
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  // drop a single trailing empty row
  if (rows.length > 0 && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === "") {
    rows.pop();
  }
  return rows;
}

export interface ColumnMapping {
  email: number;
  firstName?: number;
  lastName?: number;
}

export interface ParsedContact {
  email: string;
  firstName?: string;
  lastName?: string;
  fields: Record<string, string>;
  rowNumber: number;
}

/**
 * Map parsed rows to contacts. First row is treated as a header.
 * Columns not mapped to email/firstName/lastName become passthrough `fields`.
 */
export function mapRowsToContacts(
  rows: string[][],
  mapping: ColumnMapping
): { contacts: ParsedContact[]; errors: string[] } {
  const contacts: ParsedContact[] = [];
  const errors: string[] = [];
  if (rows.length === 0) return { contacts, errors: ["CSV is empty"] };
  const header = rows[0];
  const width = header.length;

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const rowNumber = r + 1;
    if (row.every((c) => c.trim() === "")) continue; // skip blank lines
    const email = (row[mapping.email] ?? "").trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      errors.push(`row ${rowNumber}: invalid or missing email`);
      continue;
    }
    const fields: Record<string, string> = {};
    for (let c = 0; c < width; c++) {
      if (c === mapping.email || c === mapping.firstName || c === mapping.lastName) continue;
      const key = (header[c] ?? `col_${c}`).trim() || `col_${c}`;
      const val = (row[c] ?? "").trim();
      if (val) fields[key] = val;
    }
    contacts.push({
      email,
      firstName: mapping.firstName != null ? (row[mapping.firstName] ?? "").trim() || undefined : undefined,
      lastName: mapping.lastName != null ? (row[mapping.lastName] ?? "").trim() || undefined : undefined,
      fields,
      rowNumber,
    });
  }
  return { contacts, errors };
}

/** Guess the mapping from header names (email, first_name/firstname, last_name/lastname). */
export function guessMapping(header: string[]): ColumnMapping | null {
  const norm = header.map((h) => h.trim().toLowerCase().replace(/[\s_-]+/g, ""));
  const find = (...names: string[]) => {
    const idx = norm.findIndex((h) => names.includes(h));
    return idx >= 0 ? idx : undefined;
  };
  const email = find("email", "emailaddress", "e-mail");
  if (email == null) return null;
  return {
    email,
    firstName: find("firstname", "fname", "givenname"),
    lastName: find("lastname", "lname", "surname", "familyname"),
  };
}
