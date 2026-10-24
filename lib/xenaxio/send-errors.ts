// xenaxio (step 30): the mail server sends only when the From address is the
// sender's own (the address of the chosen identity). A From the user typed in
// by hand (Bulwark's "From override") is refused with this SMTP reply.
const FOREIGN_FROM = /\b5\.7\.1 (The From address must be your own address|Only one From address is allowed)/;

/** True when the server refused the message because of its From address. */
export function isForeignFromRefusal(err: unknown): boolean {
  return err instanceof Error && FOREIGN_FROM.test(err.message);
}
