# Why use hypermedia to build an API?

Hypermedia puts more responsibility on the server so clients need less
API-specific logic. This is especially valuable when several independently
maintained clients use the same API: each client can reuse decisions and
interaction protocols instead of reimplementing them.

## Follow links instead of constructing URLs

The server supplies URLs, so clients do not need to assemble paths and query
parameters. An order can link directly to its customer, for example, instead of
requiring the client to extract a customer ID and know which endpoint accepts
it. Relationships between resources are explicit in the response.

Clients depend on the meaning of links rather than URL structure. Servers can
reorganize URLs, or move resources to another service, without changing client
routing logic, provided the interaction contracts remain compatible. Previously
returned URLs may still be bookmarked, so compatibility still matters. Moving
across domains also requires appropriate authentication and, for browser
clients, cross-origin configuration.

## Use available interactions instead of duplicating rules

A server can include a cancellation link only when the current user can cancel
an order. A client can use that link's presence to offer cancellation without
duplicating the server's rules about permissions, order status, or time limits.
Unlike a `canCancel` flag, the link supplies a target, and its relation defines
how to perform the interaction.

Availability can change after a response is received. The server must still
validate each request and explain failures, such as an order becoming
non-cancellable before the client follows its cancellation link.

## Reuse interaction protocols across resource types

Link relations define interaction protocols: sequences of HTTP interactions
that clients can implement once and reuse. Profiles describe resource-specific
request and response payloads. An API-defined cancellation relation could use
the same protocol for cancelling an order or stopping report generation, while
allowing different inputs and outputs.

Protocols can also describe multi-step workflows. A `select` link could return
eligible resources and a `select/commit` link to which the client posts its
selection. The server controls eligibility and supplies the URLs at each step.
The same workflow can support different resource types, even within one list;
clients still need to understand type-specific data they display or interpret.

## Understand the contract and the tradeoffs

Hypermedia does not remove the need for a specification. Clients still need to
understand the relations and profiles they may encounter. The specification
describes what interactions should be possible; each response supplies the
links currently available for that resource.

These benefits require more care in server design, and navigating the resource
graph can require more requests than calling known endpoints directly. The
investment is most useful when simpler clients and independent evolution pay
off across multiple integrations. An API exposing a small, cohesive set of
operations under strict latency requirements may be better served by direct
endpoint access.