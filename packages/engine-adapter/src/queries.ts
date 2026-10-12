// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { AdapterError } from "./errors.js";

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

export interface DeclaredSpecialization {
  kind: string;
  declared: string;
  targetId: string;
  targetKind: string;
}
export interface TypeInfo {
  declared: string;
  resolvedId: string;
  resolvedKind: string;
  primitive: string;
  primitiveSource: string;
  quantity: boolean;
  unit: string;
}
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
  typeInfo: TypeInfo | null;
  multiplicity: { lower: string; upper: string } | null;
  typedBy: string[];
  declaredSpecializations: DeclaredSpecialization[];
  generalizations: Generalization[];
  features: Feature[];
  metadata: Annotation[];
  relationships: Relationship[];
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
