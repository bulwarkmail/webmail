/* @metadata:begin
{"version":1,"rules":[{"id":"bw-news","name":"Archive newsletters","enabled":true,"matchType":"any","conditions":[{"field":"header","comparator":"contains","value":"unsubscribe","headerName":"List-Unsubscribe"},{"field":"from","comparator":"contains","value":"newsletter@"}],"actions":[{"type":"move","value":"Newsletters"}],"stopProcessing":false},{"id":"bw-vip","name":"Flag VIP senders","enabled":true,"matchType":"any","conditions":[{"field":"from","comparator":"is","value":"ceo@company.com"},{"field":"from","comparator":"is","value":"board@company.com"}],"actions":[{"type":"star"},{"type":"mark_read"}],"stopProcessing":false}]}
@metadata:end */

require ["body", "copy", "fileinto", "imap4flags", "relational"];

# Rule: Archive newsletters
if anyof(header :contains "List-Unsubscribe" "unsubscribe", header :contains "From" "newsletter@") {
    fileinto "Newsletters";
}

# Rule: Flag VIP senders
if anyof(header :is "From" "ceo@company.com", header :is "From" "board@company.com") {
    addflag "\\Flagged";
    addflag "\\Seen";
}

# --- External rules (managed outside Bulwark) ---

# rule:[Finance - auto-file invoices]
if allof(header :contains "From" "billing@", header :contains "Subject" "invoice") {
    fileinto :copy "Finance/Invoices";
    keep;
}

# Nextcloud Mail - begin
# Filter installed by Nextcloud Mail app
if header :contains "Subject" "[Support]" {
    fileinto "Support";
}
# Nextcloud Mail - end

# A handwritten rule without a tool-specific marker.
# Bulwark should recognize this as generic "External" and preserve it.
if not header :is "X-Spam-Status" "No" {
    fileinto "Junk";
}

# A rule using a Sieve construct Bulwark's visual editor does not understand.
# It must survive round-trips verbatim, shown to the user as read-only.
if header :value "ge" :comparator "i;ascii-numeric" "X-Priority" ["3"] {
    fileinto "LowPriority";
    stop;
}
