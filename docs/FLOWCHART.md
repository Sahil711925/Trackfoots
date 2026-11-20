# The diagram, in one breath

*A forty-second read-aloud for `public/img/tree.svg`. Point at each stage chip as you say its number.*

Sixteen log lines, in the order they arrived, each one carrying the hash of the line before it. That is the chain. Read the left column downward: ssh login accepted, session opened root, and at number seven, `sudo su - root`. Rows four and thirteen are dashed, because they were deleted after the batch was sealed.

Stage two hashes each entry once — `SHA256(0x00 || entry)` — giving h1 through h16. Stage three hashes the pairs, `SHA256(0x01 || left || right)`: sixteen become eight, four, two. Follow the saffron line up from h7. Four hashes to the root. That is the entire proof — four hashes, not sixteen, 128 bytes. The four saffron dots are exactly what a verifier needs.

Stage four is the root: one 32-byte digest committing to all sixteen entries. Stage five writes it once, in a single transaction, as `anchor(seq, root, org)`. There is no update path. A second write reverts.

The `0x00` and `0x01` prefixes are RFC 6962 domain separation, so a leaf can never be passed off as an interior node. And the dashed leaves still count: the root commits to them, so deleting the row did not erase the event.
