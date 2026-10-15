// SPDX-License-Identifier: Apache-2.0
import type { OutlinePresentation } from "../../language-service.js";

type Classification = Pick<OutlinePresentation, "family" | "role">;
type NotationGroup = readonly [
  family: OutlinePresentation["family"],
  role: OutlinePresentation["role"],
  ...spellings: string[],
];

// Display vocabulary supplied by the engine's DocumentSymbol.detail, including
// its spaced classification fallback for recorded symbols. These labels are not
// a source-language parser and do not recover information absent from the detail.
const NOTATIONS: readonly NotationGroup[] = [
  ["package", "other", "package"],
  ["namespace", "other", "namespace"],
  ["alias", "other", "alias"],
  ["dependency", "other", "dependency"],
  ["comment", "other", "comment"],
  ["documentation", "other", "doc", "documentation"],
  ["textual-representation", "other", "rep", "textual representation"],
  ["part", "definition", "part def"],
  ["part", "usage", "part", "part usage", "actor", "stakeholder"],
  ["item", "definition", "item def"],
  ["item", "usage", "item", "item usage"],
  ["attribute", "definition", "attribute def"],
  ["attribute", "usage", "attribute", "attribute usage"],
  ["enumeration", "definition", "enum def"],
  // The engine uses enum for usages and literals alike; it cannot identify a
  // literal from this detail alone.
  ["enumeration", "usage", "enum", "enum usage"],
  ["metadata", "definition", "metadata def"],
  ["metadata", "usage", "metadata", "metadata usage", "@"],
  ["occurrence", "definition", "occurrence def"],
  ["occurrence", "usage", "occurrence", "occurrence usage", "event", "snapshot", "timeslice"],
  ["individual", "definition", "individual def"],
  ["individual", "usage", "individual", "individual usage"],
  ["port", "definition", "port def"],
  ["port", "usage", "port", "port usage"],
  ["interface", "definition", "interface def"],
  ["interface", "usage", "interface", "interface usage"],
  ["connection", "definition", "connection def"],
  ["connection", "usage", "connection", "connection usage", "connector", "connect"],
  ["flow", "definition", "flow def", "message def"],
  ["flow", "usage", "flow", "flow usage", "message", "succession flow"],
  ["allocation", "definition", "allocation def"],
  ["allocation", "usage", "allocation", "allocation usage", "allocate"],
  ["action", "definition", "action def"],
  [
    "action",
    "usage",
    "action",
    "action usage",
    "step",
    "perform",
    "perform action",
    "entry action",
    "do action",
    "exit action",
  ],
  ["state", "definition", "state def"],
  [
    "state",
    "usage",
    "state",
    "state usage",
    "exhibit",
    "exhibit state",
    "history",
    "shallow history",
    "deep history",
  ],
  ["calculation", "definition", "calc def"],
  ["calculation", "usage", "calc", "calc usage", "expr"],
  ["constraint", "definition", "constraint def"],
  ["constraint", "usage", "constraint", "constraint usage", "inv", "assert", "assume", "require"],
  ["requirement", "definition", "requirement def"],
  [
    "requirement",
    "usage",
    "requirement",
    "requirement usage",
    "satisfy",
    "verify",
    "satisfy requirement",
    "satisfy requirement usage",
  ],
  ["concern", "definition", "concern def"],
  ["concern", "usage", "concern", "concern usage", "frame"],
  ["case", "definition", "case def"],
  ["case", "usage", "case", "case usage"],
  ["analysis-case", "definition", "analysis def", "analysis case def"],
  ["analysis-case", "usage", "analysis", "analysis case", "analysis case usage"],
  ["verification-case", "definition", "verification def", "verification case def"],
  ["verification-case", "usage", "verification", "verification case", "verification case usage"],
  ["use-case", "definition", "use case def"],
  ["use-case", "usage", "use case", "use case usage", "include", "include use case"],
  ["view", "definition", "view def"],
  ["view", "usage", "view", "view usage"],
  ["viewpoint", "definition", "viewpoint def"],
  ["viewpoint", "usage", "viewpoint", "viewpoint usage"],
  ["rendering", "definition", "rendering def"],
  ["rendering", "usage", "rendering", "rendering usage", "render"],
  ["binding", "definition", "binding def"],
  ["binding", "usage", "binding", "binding usage", "bind"],
  ["succession", "usage", "succession", "succession usage"],
  ["connector-end", "usage", "connector end"],
  ["cross-feature", "usage", "cross feature"],
  ["multiplicity", "usage", "multiplicity"],
  ["reference", "usage", "reference usage", "ref"],
  ["class", "definition", "class", "class def"],
  [
    "classifier",
    "definition",
    "classifier",
    "classifier def",
    "subclassifier",
    "subclassifier def",
  ],
  ["struct", "definition", "struct", "struct def"],
  ["datatype", "definition", "datatype", "datatype def"],
  ["association", "definition", "assoc", "assoc def", "assoc struct"],
  ["metaclass", "definition", "metaclass", "metaclass def"],
  ["type", "definition", "type", "kerml type"],
  ["feature", "definition", "feature def"],
  ["feature", "usage", "feature"],
  ["behavior", "definition", "behavior", "behavior def", "interaction"],
  ["function", "definition", "function", "function def"],
  ["predicate", "definition", "predicate", "predicate def", "bool def"],
  ["predicate", "usage", "bool"],
  ["transition", "usage", "transition"],
  ["decision", "usage", "decide", "choice"],
  ["fork", "usage", "fork"],
  ["join", "usage", "join"],
  ["merge", "usage", "merge", "junction"],
  ["send", "usage", "send"],
  ["accept", "usage", "accept"],
  ["assignment", "usage", "assign"],
  ["terminate", "usage", "terminate"],
  ["loop", "usage", "while", "loop", "for"],
  ["condition", "usage", "if"],
  ["subject", "usage", "subject", "objective"],
  [
    "relationship",
    "other",
    "relationship",
    "specialization",
    "subtype",
    "typing",
    "subset",
    "redefinition",
    "conjugation",
    "conjugate",
    "inverting",
    "inverse",
    "disjoining",
    "disjoint",
    "featuring",
  ],
];

const classifications = new Map<string, Classification>(
  NOTATIONS.flatMap(([family, role, ...spellings]) =>
    spellings.map((spelling) => [spelling, { family, role }] as const),
  ),
);

// These engine-recorded usage prefixes qualify a recognized kind. Neither a
// prefix nor a def suffix is enough to classify an otherwise unknown label.
const usagePrefixes = ["var", "assert", "assume", "require"] as const;

export function outlinePresentation(detail: string): OutlinePresentation | undefined {
  if (!detail) return undefined;
  const separator = detail.indexOf(" : ");
  const kind = separator < 0 ? detail : detail.slice(0, separator);
  const reference = kind === "ref" || kind === "reference usage" || kind.startsWith("ref ");
  const notation = kind.startsWith("ref ") ? kind.slice(4) : kind;
  let classification = classifications.get(notation);
  if (!classification) {
    const prefix = usagePrefixes.find((value) => notation.startsWith(`${value} `));
    if (prefix) {
      const qualified = classifications.get(notation.slice(prefix.length + 1));
      if (qualified?.role === "usage") classification = qualified;
    }
  }
  const { family, role }: Classification = classification ?? { family: "other", role: "other" };
  return {
    kind,
    family,
    role,
    definition: role === "definition",
    reference,
    ...(separator < 0 ? {} : { declaredType: detail.slice(separator + 3) }),
  };
}
