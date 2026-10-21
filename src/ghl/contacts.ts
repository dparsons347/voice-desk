import { z } from "zod";
import type { HighLevelClient } from "./client.js";

export const ContactSchema = z.looseObject({
  id: z.string(),
  phone: z.string().nullish(),
  firstName: z.string().nullish(),
  lastName: z.string().nullish(),
  dnd: z.boolean().nullish(),
  dndSettings: z.record(z.string(), z.looseObject({ status: z.string().nullish() })).nullish(),
});
export type Contact = z.infer<typeof ContactSchema>;

export async function getContact(client: HighLevelClient, tool: string, contactId: string): Promise<Contact> {
  const res = await client.read({
    tool,
    operation: "contacts.get",
    path: `/contacts/${encodeURIComponent(contactId)}`,
    schema: z.looseObject({ contact: ContactSchema }),
  });
  return res.contact;
}

/** Do-not-disturb for texts: the global flag, or the SMS channel set to active. */
export function smsBlocked(contact: Contact): boolean {
  return contact.dnd === true || contact.dndSettings?.SMS?.status === "active";
}
