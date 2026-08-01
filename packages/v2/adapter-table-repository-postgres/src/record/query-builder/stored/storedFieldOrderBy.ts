import { FieldType, type DomainError, type Field } from '@teable/v2-core';
import { sql, type RawBuilder } from 'kysely';
import { err, ok, type Result } from 'neverthrow';

import { buildDateLikeOrderExpression } from '../dateLikeOrderBy';

export type StoredFieldOrderByClause = {
  readonly expression: RawBuilder<unknown>;
  readonly direction: 'asc' | 'desc';
};

const extractSelectChoiceOrder = (
  field: Field
): { mode: 'single' | 'multiple'; values: string[] } | undefined => {
  const candidate = field as Field & {
    selectOptions?: () => ReadonlyArray<{ name: () => { toString: () => string } }>;
    innerField?: () => { isOk: () => boolean; value: unknown };
  };
  const fieldType = field.type();
  const toChoiceNames = (
    options: ReadonlyArray<{ name: () => { toString: () => string } }> | undefined
  ): string[] | undefined => {
    const names = options?.map((option) => option.name().toString()).filter(Boolean);
    return names?.length ? names : undefined;
  };

  if (fieldType.equals(FieldType.singleSelect()) || fieldType.equals(FieldType.multipleSelect())) {
    const values = toChoiceNames(candidate.selectOptions?.());
    return values
      ? {
          mode: fieldType.equals(FieldType.multipleSelect()) ? 'multiple' : 'single',
          values,
        }
      : undefined;
  }

  if (!fieldType.equals(FieldType.lookup())) return undefined;
  const innerFieldResult = candidate.innerField?.();
  if (!innerFieldResult?.isOk()) return undefined;

  const innerField = innerFieldResult.value as {
    type?: () => { equals: (other: unknown) => boolean };
    selectOptions?: () => ReadonlyArray<{ name: () => { toString: () => string } }>;
  };
  const innerType = innerField.type?.();
  if (
    !innerType ||
    (!innerType.equals(FieldType.singleSelect()) && !innerType.equals(FieldType.multipleSelect()))
  ) {
    return undefined;
  }
  const values = toChoiceNames(innerField.selectOptions?.());
  if (!values) return undefined;

  const multiplicityResult = field.isMultipleCellValue();
  const isMultiple =
    multiplicityResult.isOk() &&
    (innerType.equals(FieldType.multipleSelect()) || multiplicityResult.value.isMultiple());
  return { mode: isMultiple ? 'multiple' : 'single', values };
};

const withNullOrdering = (
  expression: RawBuilder<unknown>,
  direction: 'asc' | 'desc'
): StoredFieldOrderByClause[] => [
  {
    expression: sql`${expression} is null`,
    direction: direction === 'asc' ? 'desc' : 'asc',
  },
  { expression, direction },
];

export const buildStoredFieldOrderByClauses = (
  field: Field,
  column: string,
  direction: 'asc' | 'desc',
  tableAlias: string,
  columnExpression?: RawBuilder<unknown>
): Result<ReadonlyArray<StoredFieldOrderByClause>, DomainError> => {
  const fieldType = field.type();
  const columnRef = columnExpression ?? sql.ref(`${tableAlias}.${column}`);
  const selectChoiceOrder = extractSelectChoiceOrder(field);

  if (selectChoiceOrder) {
    const choiceArrayLiteral = sql`ARRAY[${sql.join(
      selectChoiceOrder.values.map((name) => sql`${name}`),
      sql`, `
    )}]`;
    const choiceIndexExpression =
      selectChoiceOrder.mode === 'multiple'
        ? sql`CASE
            WHEN ${columnRef} IS NULL THEN NULL
            WHEN jsonb_typeof(${columnRef}::jsonb) = 'array'
              THEN ARRAY_POSITION(${choiceArrayLiteral}, jsonb_path_query_first(${columnRef}::jsonb, '$[0]') #>> '{}')
            ELSE ARRAY_POSITION(${choiceArrayLiteral}, ${columnRef}::text)
          END`
        : sql`ARRAY_POSITION(${choiceArrayLiteral}, ${columnRef}::text)`;
    const clauses = withNullOrdering(choiceIndexExpression, direction);
    return ok(
      selectChoiceOrder.mode === 'multiple'
        ? [...clauses, { expression: sql`${columnRef}::jsonb::text`, direction }]
        : clauses
    );
  }

  const isUserLike =
    fieldType.equals(FieldType.user()) ||
    fieldType.equals(FieldType.link()) ||
    fieldType.equals(FieldType.createdBy()) ||
    fieldType.equals(FieldType.lastModifiedBy());
  if (isUserLike) {
    const multiplicityResult = field.isMultipleCellValue();
    if (multiplicityResult.isErr()) return err(multiplicityResult.error);

    const source =
      fieldType.equals(FieldType.createdBy()) || fieldType.equals(FieldType.lastModifiedBy())
        ? 'system'
        : 'field';
    const columnJson = source === 'field' ? sql`${columnRef}::jsonb` : sql`to_jsonb(${columnRef})`;
    const arrayLikeColumnJson =
      source === 'field'
        ? sql`CASE
            WHEN jsonb_typeof(${columnJson}) = 'array' THEN ${columnJson}
            WHEN jsonb_typeof(${columnJson}) = 'object' THEN jsonb_build_array(${columnJson})
            ELSE '[]'::jsonb
          END`
        : sql`CASE
            WHEN jsonb_typeof(${columnJson}) = 'array' THEN ${columnJson}
            ELSE '[]'::jsonb
          END`;
    const titleExpression = multiplicityResult.value.isMultiple()
      ? sql`jsonb_path_query_array(${arrayLikeColumnJson}, '$[*].title')::text`
      : source === 'field'
        ? sql`${columnJson} ->> 'title'`
        : sql`coalesce(${columnJson} ->> 'title', ${columnJson} ->> 'name', ${columnJson} #>> '{}')`;
    return ok(withNullOrdering(titleExpression, direction));
  }

  // An explicit columnExpression (error fallback, grouped date bucket) is
  // already the value to order by; rebuilding from the raw column would
  // reference an ungrouped column in grouped queries.
  const dateExpression = columnExpression
    ? null
    : buildDateLikeOrderExpression(field, tableAlias, column);
  return ok(withNullOrdering(dateExpression ?? sql`${columnRef}`, direction));
};
