// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { AdapterError } from "./errors.js";
import type { EngineConnection } from "./engine.js";

export const queryNameSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine((s) => ![...s].some((char) => char.charCodeAt(0) < 32));
export const metadataFilterSchema = z
  .object({
    type: queryNameSchema,
    values: z
      .record(
        z.string().min(1).max(256),
        z.union([
          z.string().max(4096),
          z
            .number()
            .finite()
            .refine((n) => !Number.isInteger(n) || Number.isSafeInteger(n)),
          z.boolean(),
        ]),
      )
      .refine((v) => Object.keys(v).length <= 16)
      .optional(),
  })
  .strict();
export const findInputSchema = z
  .object({
    name: queryNameSchema.optional(),
    qualifiedName: queryNameSchema.optional(),
    kind: queryNameSchema.optional(),
    scope: z.array(queryNameSchema).max(32).optional(),
    specializes: queryNameSchema.optional(),
    metadata: metadataFilterSchema.optional(),
    limit: z.number().int().min(1).max(500).optional(),
    cursor: z.string().min(1).max(128).optional(),
  })
  .strict();
export const describeInputSchema = z
  .object({
    qualifiedName: queryNameSchema,
    includeInherited: z.boolean().optional(),
  })
  .strict();
export const libraryInputSchema = z
  .object({
    qualifiedName: queryNameSchema.optional(),
    namespace: queryNameSchema.optional(),
    name: queryNameSchema.optional(),
    kind: queryNameSchema.optional(),
    limit: z.number().int().min(1).max(500).optional(),
    cursor: z.string().min(1).max(128).optional(),
  })
  .strict()
  .refine((v) => !!v.cursor || !!v.qualifiedName !== !!v.namespace, {
    message: "Choose an exact qualifiedName or a namespace to browse.",
  })
  .refine((v) => !v.qualifiedName || (!v.name && !v.kind && !v.namespace), {
    message: "Exact lookup cannot also use search filters.",
  });
export type FindInput = z.infer<typeof findInputSchema>;
export type DescribeInput = z.infer<typeof describeInputSchema>;
export type LibraryInput = z.infer<typeof libraryInputSchema>;

const rowSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  properties: z.record(z.string(), z.string()).default({}),
});
const rowsSchema = z.object({ elements: z.array(rowSchema).default([]) }).strict();
const specializationSchema = z.object({
  kind: z.string(),
  declared: z.string().default(""),
  targetId: z.string().default(""),
  targetKind: z.string().default(""),
});
const typeSchema = z.object({
  declared: z.string().default(""),
  resolvedId: z.string().default(""),
  resolvedKind: z.string().default(""),
  primitive: z.string().default(""),
  primitiveSource: z.string().default(""),
  quantity: z.boolean().default(false),
  unit: z.string().default(""),
});
const symbolSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  kind: z.string(),
  childIds: z.array(z.string()).default([]),
  attributes: z.array(z.object({ name: z.string(), type: z.string().default("") })).default([]),
  typeInfo: typeSchema.optional(),
  multiplicity: z
    .object({ lower: z.string().default(""), upper: z.string().default("") })
    .optional(),
  specializations: z.array(specializationSchema).default([]),
  withheldLibraryAttributes: z.number().int().nonnegative().default(0),
});
type Row = z.infer<typeof rowSchema>;
export interface ElementSummary {
  id: string;
  name: string | null;
  qualifiedName: string | null;
  kind: string;
  owner: string | null;
  documentation: string | null;
}
export interface QueryAnswer<T> {
  items: T[];
  limitations: string[];
}
export interface Feature {
  id: string;
  name: string;
  nativeKind: string;
  declaringOwner: string;
  inheritedFrom: string | null;
  types: string[];
}
export interface Generalization {
  target: string;
  declaredKind: string | null;
  implicit: boolean | null;
  kindImplicit: boolean;
  semanticMetadataImplicit: boolean;
}
export type Scalar =
  | { kind: "string"; value: string }
  | { kind: "boolean"; value: boolean }
  | { kind: "integer"; value: string }
  | { kind: "real"; value: number };
export interface Annotation {
  type: string;
  ordinal: number;
  semantic: boolean;
  prefix: boolean;
  keyword: string | null;
  about: boolean;
  values: Record<string, Scalar>;
}
export interface Relationship {
  id: string;
  kind: "satisfy" | "connect";
  source: string | null;
  target: string | null;
}
export interface ElementDescription {
  element: ElementSummary;
  nativeKind: string;
  typeInfo: z.infer<typeof typeSchema> | null;
  multiplicity: { lower: string; upper: string } | null;
  typedBy: string[];
  declaredSpecializations: z.infer<typeof specializationSchema>[];
  generalizations: Generalization[];
  features: Feature[];
  metadata: Annotation[];
  relationships: Relationship[];
}

function malformed(): never {
  throw new AdapterError("ENGINE_PROTOCOL_ERROR", "The engine returned malformed query data.");
}
function required(props: Record<string, string>, key: string): string {
  const value = props[key];
  if (!value) return malformed();
  return value;
}
function flag(props: Record<string, string>, key: string): boolean {
  if (props[key] !== "true" && props[key] !== "false") return malformed();
  return props[key] === "true";
}
export function parseInput<S extends z.ZodType>(schema: S, input: unknown): z.infer<S> {
  const result = schema.safeParse(input);
  if (!result.success)
    throw new AdapterError(
      "INVALID_ARGUMENT",
      "The query arguments do not match this tool's schema.",
    );
  return result.data;
}
function summary(row: Row): ElementSummary {
  return {
    id: row.id,
    name: row.properties.name ?? null,
    qualifiedName: row.properties.qualifiedName ?? null,
    kind: row.type,
    owner: row.properties.owner ?? null,
    documentation: row.properties.documentation ?? null,
  };
}
function equal(property: string, value: string) {
  return { primitive: { property, operator: "PRIMITIVE_OPERATOR_EQUAL", value: [value] } };
}
const projection = [
  "name",
  "qualifiedName",
  "owner",
  "documentation",
  "satisfiedRequirement",
  "satisfyingFeature",
];

// This validates expression operands, not name resolution. Only the native
// engine resolves names or evaluates metadata. Unsupported spellings are refused.
function operand(name: string): string {
  if (
    !/^(?:[A-Za-z_][A-Za-z_0-9]*|'(?:\\[^\r\n]|[^'\\\r\n])*')(?:::(?:[A-Za-z_][A-Za-z_0-9]*|'(?:\\[^\r\n]|[^'\\\r\n])*'))*$/u.test(
      name,
    )
  ) {
    // The native API can return display names without source quotes. Escape
    // simple display-name segments as unrestricted names; do not infer bindings.
    const segments = name.split("::");
    if (segments.every((part) => /^[\p{L}\p{N}_ -]+$/u.test(part) && part.trim().length > 0))
      return segments.map(member).join("::");
    throw new AdapterError(
      "UNSUPPORTED_CAPABILITY",
      "This qualified-name spelling cannot safely be used in a metadata expression.",
    );
  }
  return name;
}
function member(name: string): string {
  if (!name || [...name].some((char) => char.charCodeAt(0) < 32))
    throw new AdapterError(
      "UNSUPPORTED_CAPABILITY",
      "This metadata property name is not addressable.",
    );
  return "'" + name.replaceAll("\\", "\\\\").replaceAll("'", "\\'") + "'";
}
function scalar(value: Record<string, unknown>): Scalar | null {
  if (typeof value.stringValue === "string") return { kind: "string", value: value.stringValue };
  if (typeof value.boolValue === "boolean") return { kind: "boolean", value: value.boolValue };
  if (typeof value.intValue === "string" && /^-?\d+$/u.test(value.intValue))
    return { kind: "integer", value: value.intValue };
  if (typeof value.realValue === "number" && Number.isFinite(value.realValue))
    return { kind: "real", value: value.realValue };
  return null;
}
function matches(actual: Scalar, expected: string | number | boolean): boolean {
  if (actual.kind === "integer")
    return (
      typeof expected === "number" &&
      Number.isSafeInteger(expected) &&
      BigInt(actual.value) === BigInt(expected)
    );
  return actual.value === expected;
}

export class NativeQueries {
  constructor(
    private readonly engine: EngineConnection,
    private readonly modelHash: string,
    private readonly signal: AbortSignal,
  ) {}
  private async call(method: string, params: object): Promise<unknown> {
    if (this.signal.aborted) throw new AdapterError("CANCELLED", "The request was cancelled.");
    return this.engine.request(method, { modelHash: this.modelHash, ...params }, this.signal);
  }
  private async rows(method: string, params: object): Promise<Row[]> {
    const result = rowsSchema.safeParse(await this.call(method, params));
    if (!result.success) return malformed();
    if (result.data.elements.length > 10000)
      throw new AdapterError(
        "LIMIT_EXCEEDED",
        "The native query exceeds the 10000-element result limit; narrow its scope.",
      );
    return result.data.elements;
  }
  private async query(query: object): Promise<Row[]> {
    return this.rows("Query", { query: { select: projection, ...query } });
  }
  private async symbol(name: string) {
    const response = z
      .object({ symbol: symbolSchema.optional(), error: z.string().default("") })
      .safeParse(await this.call("GetSymbol", { symbolId: name }));
    if (!response.success) return malformed();
    if (response.data.error)
      throw new AdapterError(
        "ELEMENT_NOT_FOUND",
        "The requested element was not found in this model.",
      );
    if (!response.data.symbol) return malformed();
    return response.data.symbol;
  }
  private async evaluate(expression: string): Promise<Record<string, unknown>> {
    const response = z
      .object({
        result: z.record(z.string(), z.unknown()).optional(),
        error: z.string().default(""),
      })
      .safeParse(await this.call("Evaluate", { expression }));
    if (!response.success) return malformed();
    if (response.data.error)
      throw new AdapterError(
        "QUERY_UNAVAILABLE",
        "The engine could not evaluate the requested metadata value.",
      );
    if (!response.data.result) return malformed();
    return response.data.result;
  }
  private async annotationExpressions(element: string, type: string): Promise<string[]> {
    const expression = `(${operand(element)} meta ${operand(type)})`;
    const response = await this.evaluate(expression);
    const sequence = z
      .object({ elements: z.array(z.object({ instanceId: z.string().min(1) })).default([]) })
      .safeParse(response.sequence);
    if (!sequence.success)
      throw new AdapterError(
        "QUERY_UNAVAILABLE",
        "The engine did not return addressable metadata instances.",
      );
    if (sequence.data.elements.length > 128)
      throw new AdapterError(
        "LIMIT_EXCEEDED",
        "This element has too many metadata instances for one query.",
      );
    return sequence.data.elements.map((_, i) => `${expression}#(${i + 1})`);
  }
  private async metadataMatches(
    element: string,
    filter: NonNullable<FindInput["metadata"]>,
  ): Promise<boolean> {
    for (const expression of await this.annotationExpressions(element, filter.type)) {
      let accepted = true;
      for (const [property, expected] of Object.entries(filter.values ?? {})) {
        const actual = scalar(await this.evaluate(`(${expression}).${member(property)}`));
        if (!actual)
          throw new AdapterError(
            "UNSUPPORTED_CAPABILITY",
            "Metadata value filtering currently supports scalar strings, Booleans, integers and reals only.",
          );
        if (!matches(actual, expected)) accepted = false;
      }
      if (accepted) return true;
    }
    return false;
  }
  async find(input: FindInput): Promise<QueryAnswer<ElementSummary>> {
    const constraints = [];
    if (input.name) constraints.push(equal("name", input.name));
    if (input.qualifiedName) constraints.push(equal("qualifiedName", input.qualifiedName));
    if (input.kind) constraints.push(equal("@type", input.kind));
    const where =
      constraints.length === 1
        ? constraints[0]
        : constraints.length
          ? { composite: { operator: "COMPOSITE_OPERATOR_AND", constraint: constraints } }
          : undefined;
    let rows = await this.query({
      ...(input.scope?.length ? { scope: input.scope } : {}),
      ...(where ? { where } : {}),
    });
    const limitations: string[] = [];
    if (input.specializes) {
      const native = await this.rows("DryasFindBySpecialization", { symbolId: input.specializes });
      const selected = new Set(native.map((row) => row.id));
      rows = rows.filter((row) => selected.has(row.id));
    }
    if (input.metadata) {
      if (rows.length > 2000)
        throw new AdapterError(
          "LIMIT_EXCEEDED",
          "Narrow the scope to at most 2000 elements before filtering metadata.",
        );
      await this.rows("DryasDescribeProvenance", { symbolId: input.metadata.type });
      const type = await this.symbol(input.metadata.type);
      if (!["metadataDef", "metaclass"].includes(type.kind))
        throw new AdapterError(
          "INVALID_ARGUMENT",
          "The metadata filter must name a metadata definition or metaclass.",
        );
      const selected: Row[] = [];
      for (const row of rows) {
        const name = row.properties.qualifiedName;
        if (!name) {
          limitations.push(
            "Unnamed elements are excluded from metadata searches because the native expression interface cannot address them.",
          );
          continue;
        }
        if (await this.metadataMatches(name, input.metadata)) selected.push(row);
      }
      rows = selected;
    }
    if (new Set(rows.map((row) => row.id)).size !== rows.length)
      throw new AdapterError(
        "AMBIGUOUS_ELEMENT",
        "Multiple elements share a query identity; refine or repair the model before using these identities.",
      );
    return { items: rows.map(summary), limitations: [...new Set(limitations)] };
  }
  async describe(input: DescribeInput): Promise<QueryAnswer<ElementDescription>> {
    // Unlike GetSymbol's first-match behavior, this native operation rejects
    // ambiguous or provisional targets before we present any semantic facts.
    const provenance = await this.rows("DryasDescribeProvenance", {
      symbolId: input.qualifiedName,
    });
    const sym = await this.symbol(input.qualifiedName);
    const rows = await this.query({ scope: [sym.id], where: equal("qualifiedName", sym.id) });
    if (rows.length !== 1)
      throw new AdapterError(
        "AMBIGUOUS_ELEMENT",
        "The native query did not identify exactly one declaration.",
      );
    const generalizations: Generalization[] = provenance
      .filter((r) => r.type === "DryasGeneralization")
      .map(({ properties: p }) => ({
        target: required(p, "target"),
        declaredKind: p.declaredKind ?? null,
        implicit: p.implicit === undefined ? null : flag(p, "implicit"),
        kindImplicit: flag(p, "kindImplicit"),
        semanticMetadataImplicit: flag(p, "semanticMetadataImplicit"),
      }));
    const limitations: string[] = [];
    const members = await this.rows("DryasDescribeInherited", { symbolId: sym.id });
    if (new Set(members.map((row) => row.id)).size !== members.length)
      throw new AdapterError(
        "AMBIGUOUS_ELEMENT",
        "The engine returned conflicting inherited-member identities.",
      );
    const features: Feature[] = members
      .filter((r) => input.includeInherited !== false || r.properties.declaringOwner === sym.id)
      .map((row) => {
        let types: unknown;
        try {
          types = JSON.parse(required(row.properties, "types"));
        } catch {
          return malformed();
        }
        const parsed = z.array(z.string().min(1)).safeParse(types);
        if (!parsed.success) return malformed();
        return {
          id: row.id,
          name: required(row.properties, "name"),
          nativeKind: row.type,
          declaringOwner: required(row.properties, "declaringOwner"),
          inheritedFrom: row.properties.inheritedFrom ?? null,
          types: parsed.data,
        };
      });
    const metadata: Annotation[] = [];
    for (const row of provenance.filter((r) => r.type === "DryasMetadataAnnotation")) {
      const p = row.properties,
        type = required(p, "type"),
        ordinal = Number(required(p, "typeOrdinal"));
      if (!Number.isInteger(ordinal) || ordinal < 1 || ordinal > 128) return malformed();
      const annotation: Annotation = {
        type,
        ordinal,
        semantic: flag(p, "semantic"),
        prefix: flag(p, "prefix"),
        keyword: p.keyword ?? null,
        about: flag(p, "about"),
        values: {},
      };
      const info = await this.symbol(type);
      if (info.attributes.length > 64)
        throw new AdapterError(
          "LIMIT_EXCEEDED",
          "This annotation has too many attributes for one description.",
        );
      if (info.withheldLibraryAttributes)
        limitations.push(
          "Metadata descriptions omit library attributes withheld by the native symbol API.",
        );
      // The native typeOrdinal indexes exact-type annotations; meta also selects
      // subtypes. Establish exact instances before choosing an ordinal.
      const exact: string[] = [];
      for (const candidate of await this.annotationExpressions(sym.id, type)) {
        const value = await this.evaluate(`(${candidate}) hastype ${operand(type)}`);
        if (typeof value.boolValue !== "boolean") return malformed();
        if (value.boolValue) exact.push(candidate);
      }
      const selected = exact[ordinal - 1];
      if (!selected)
        throw new AdapterError(
          "QUERY_UNAVAILABLE",
          "The native annotation identity and evaluated instances do not agree.",
        );
      for (const attribute of info.attributes) {
        try {
          const value = scalar(await this.evaluate(`(${selected}).${member(attribute.name)}`));
          if (value) annotation.values[attribute.name] = value;
          else
            limitations.push(
              "Some metadata values are non-scalar or unavailable and were not projected.",
            );
        } catch (error) {
          if (!(error instanceof AdapterError) || error.code !== "QUERY_UNAVAILABLE") throw error;
          limitations.push("Some metadata values could not be evaluated by the engine.");
        }
      }
      metadata.push(annotation);
    }
    const relations = await this.query({
      scope: [sym.id],
      where: {
        primitive: {
          property: "@type",
          operator: "PRIMITIVE_OPERATOR_EQUAL",
          value: ["SatisfyRequirementUsage", "ConnectionUsage", "InterfaceUsage"],
        },
      },
    });
    const relationships: Relationship[] = relations.map((r) => ({
      id: r.id,
      kind: r.type === "SatisfyRequirementUsage" ? "satisfy" : "connect",
      source: r.properties.satisfyingFeature ?? null,
      target: r.properties.satisfiedRequirement ?? null,
    }));
    if (relationships.some((r) => r.kind === "connect"))
      limitations.push(
        "Connection identities are native; this API does not expose their endpoints, which remain null.",
      );
    return {
      items: [
        {
          element: summary(rows[0]!),
          nativeKind: sym.kind,
          typeInfo: sym.typeInfo ?? null,
          multiplicity: sym.multiplicity ?? null,
          typedBy: [
            ...new Set(
              [
                sym.typeInfo?.resolvedId,
                ...sym.specializations.filter((s) => s.kind === "typing").map((s) => s.targetId),
              ].filter((s): s is string => !!s),
            ),
          ],
          declaredSpecializations: sym.specializations,
          generalizations,
          features,
          metadata,
          relationships,
        },
      ],
      limitations: [...new Set(limitations)],
    };
  }
  async library(input: LibraryInput): Promise<QueryAnswer<ElementSummary | ElementDescription>> {
    if (input.qualifiedName)
      return this.describe({ qualifiedName: input.qualifiedName, includeInherited: false });
    if (!input.namespace)
      throw new AdapterError("INVALID_ARGUMENT", "A library namespace is required for browsing.");
    const answer = await this.find({
      scope: [input.namespace],
      ...(input.name ? { name: input.name } : {}),
      ...(input.kind ? { kind: input.kind } : {}),
    });
    answer.limitations.push(
      "Namespace browsing lists declarations, not imported or re-exported members. Use an exact qualifiedName to resolve a re-export.",
    );
    return answer;
  }
}
