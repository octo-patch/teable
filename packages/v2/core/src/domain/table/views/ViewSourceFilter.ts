import { err, ok, type Result } from 'neverthrow';
import { z } from 'zod';

import type {
  RecordFilter,
  RecordFilterDateValue,
  RecordFilterNode,
  RecordFilterOperator,
  RecordFilterValue,
} from '../../../queries/RecordFilterDto';
import { domainError, type DomainError } from '../../shared/DomainError';
import { ValueObject } from '../../shared/ValueObject';
import {
  recordConditionOperatorSchema,
  recordConditionOperatorsExpectingArray,
  recordConditionOperatorsExpectingNull,
} from '../records/specs/RecordConditionOperators';

const sourceFilterSymbolOperatorMap = new Map<string, RecordFilterOperator>([
  ['=', 'is'],
  ['!=', 'isNot'],
  ['>', 'isGreater'],
  ['>=', 'isGreaterEqual'],
  ['<', 'isLess'],
  ['<=', 'isLessEqual'],
  ['LIKE', 'contains'],
  ['NOT LIKE', 'doesNotContain'],
  ['IN', 'isAnyOf'],
  ['NOT IN', 'isNoneOf'],
  ['HAS', 'hasAllOf'],
  ['IS NULL', 'isEmpty'],
  ['IS NOT NULL', 'isNotEmpty'],
]);

const sourceFilterSymbolOperatorSchema = z.enum([
  '=',
  '!=',
  '>',
  '>=',
  '<',
  '<=',
  'LIKE',
  'IN',
  'HAS',
  'NOT LIKE',
  'NOT IN',
  'IS NULL',
  'IS NOT NULL',
]);

const sourceFilterDateModeSchema = z.enum([
  'today',
  'tomorrow',
  'yesterday',
  'currentWeek',
  'currentMonth',
  'currentYear',
  'lastWeek',
  'lastMonth',
  'lastYear',
  'nextWeekPeriod',
  'nextMonthPeriod',
  'nextYearPeriod',
  'oneWeekAgo',
  'oneWeekFromNow',
  'oneMonthAgo',
  'oneMonthFromNow',
  'daysAgo',
  'daysFromNow',
  'exactDate',
  'exactDateTime',
  'exactFormatDate',
  'dateRange',
  'pastWeek',
  'pastMonth',
  'pastYear',
  'nextWeek',
  'nextMonth',
  'nextYear',
  'pastNumberOfDays',
  'nextNumberOfDays',
]);

const sourceFilterDateValueSchema = z
  .object({
    mode: sourceFilterDateModeSchema,
    numberOfDays: z.coerce.number().int().nonnegative().optional(),
    exactDate: z.string().datetime({ offset: true }).optional(),
    exactDateEnd: z.string().datetime({ offset: true }).optional(),
    timeZone: z.string().refine(
      (value) => {
        try {
          new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
          return true;
        } catch {
          return false;
        }
      },
      { message: 'Invalid timezone' }
    ),
  })
  .superRefine((value, context) => {
    const exactDateModes = ['exactDate', 'exactDateTime', 'exactFormatDate'];
    const numberOfDaysModes = ['daysAgo', 'daysFromNow', 'pastNumberOfDays', 'nextNumberOfDays'];
    if (exactDateModes.includes(value.mode) && !value.exactDate) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['exactDate'],
        message: `When mode is '${value.mode}', exactDate is required`,
      });
    }
    if (value.mode === 'dateRange') {
      if (!value.exactDate) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['exactDate'],
          message: "When mode is 'dateRange', exactDate is required",
        });
      }
      if (!value.exactDateEnd) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['exactDateEnd'],
          message: "When mode is 'dateRange', exactDateEnd is required",
        });
      }
    }
    if (numberOfDaysModes.includes(value.mode) && value.numberOfDays == null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['numberOfDays'],
        message: `When mode is '${value.mode}', numberOfDays is required`,
      });
    }
  });

const sourceFilterLiteralValueSchema = z.union([z.string(), z.number(), z.boolean()]);
const sourceFilterValueSchema = z
  .union([
    sourceFilterLiteralValueSchema,
    sourceFilterLiteralValueSchema.array().nonempty(),
    sourceFilterDateValueSchema,
    z.object({
      type: z.literal('field'),
      fieldId: z.string(),
      tableId: z.string().optional(),
    }),
  ])
  .nullable();

const normalizeUnaryOperatorValue = (input: unknown): unknown => {
  if (input == null || typeof input !== 'object') return input;
  const value = input as Record<string, unknown>;
  if (
    typeof value.operator !== 'string' ||
    !recordConditionOperatorsExpectingNull.includes(value.operator as never) ||
    Object.prototype.hasOwnProperty.call(value, 'value')
  ) {
    return input;
  }
  return { ...value, value: null };
};

const sourceFilterConditionSchema = z.preprocess(
  normalizeUnaryOperatorValue,
  z.union([
    z.object({
      isSymbol: z.literal(true),
      fieldId: z.string(),
      value: sourceFilterValueSchema,
      operator: sourceFilterSymbolOperatorSchema,
    }),
    z
      .object({
        isSymbol: z.literal(false).optional(),
        fieldId: z.string(),
        value: sourceFilterValueSchema,
        operator: recordConditionOperatorSchema,
      })
      .superRefine((value, context) => {
        if (recordConditionOperatorsExpectingNull.includes(value.operator)) {
          if (value.value !== null) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['value'],
              message: `Operator '${value.operator}' requires null`,
            });
          }
          return;
        }
        if (
          recordConditionOperatorsExpectingArray.includes(value.operator) &&
          !Array.isArray(value.value) &&
          !isFieldReference(value.value)
        ) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['value'],
            message: `Operator '${value.operator}' requires an array value`,
          });
        }
        if (
          !recordConditionOperatorsExpectingArray.includes(value.operator) &&
          Array.isArray(value.value)
        ) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['value'],
            message: `Operator '${value.operator}' does not allow an array value`,
          });
        }
      }),
  ])
);

type ViewSourceFilterConditionDTO = z.infer<typeof sourceFilterConditionSchema>;

export type ViewSourceFilterDTO = {
  conjunction: 'and' | 'or';
  filterSet: Array<ViewSourceFilterConditionDTO | ViewSourceFilterDTO>;
};

// v1 stores incomplete list-operator conditions (null or empty-array value) while
// the user is mid-editing a filter, and skips them at query time. Drop them here
// so rehydrating a persisted legacy filter cannot fail the whole table load.
const legacyListOperators: ReadonlyArray<string> = [
  ...recordConditionOperatorsExpectingArray,
  'IN',
  'NOT IN',
  'HAS',
];

const isIncompleteLegacyListCondition = (input: unknown): boolean => {
  if (input == null || typeof input !== 'object') return false;
  const value = input as Record<string, unknown>;
  if (typeof value.operator !== 'string' || !legacyListOperators.includes(value.operator)) {
    return false;
  }
  return value.value == null || (Array.isArray(value.value) && value.value.length === 0);
};

// A group whose conditions were all dropped filters nothing and must not fail
// (or survive) validation; a group that was ALREADY empty in the stored legacy
// filter is preserved verbatim (v1 kept them).
const emptiedByDrop = (before: unknown[], after: unknown[]): boolean =>
  before.length > 0 && after.length === 0;

const dropIncompleteLegacyListConditions = (input: unknown): unknown => {
  if (input == null || typeof input !== 'object' || !('filterSet' in input)) return input;
  const group = input as Record<string, unknown>;
  if (!Array.isArray(group.filterSet)) return input;
  const filterSet = group.filterSet
    .map((item) => dropIncompleteLegacyListConditions(item))
    .filter((item) => item !== undefined && !isIncompleteLegacyListCondition(item));
  if (emptiedByDrop(group.filterSet, filterSet)) return undefined;
  return { ...group, filterSet };
};

const sourceFilterGroupSchema: z.ZodType<ViewSourceFilterDTO> = z.preprocess(
  dropIncompleteLegacyListConditions,
  z.object({
    conjunction: z.enum(['and', 'or']),
    filterSet: z.array(
      z.lazy(() => z.union([sourceFilterConditionSchema, sourceFilterGroupSchema]))
    ),
  })
) as unknown as z.ZodType<ViewSourceFilterDTO>;

export const viewSourceFilterSchema: z.ZodType<ViewSourceFilterDTO | null> = z.preprocess(
  // A top-level filter reduced to nothing by the incomplete-condition cleanup
  // filters nothing — normalize it to null like v1 does at query time.
  (input) => dropIncompleteLegacyListConditions(input) ?? null,
  sourceFilterGroupSchema.nullable()
) as unknown as z.ZodType<ViewSourceFilterDTO | null>;

const isFieldReference = (
  value: unknown
): value is { type: 'field'; fieldId: string; tableId?: string } =>
  value != null &&
  typeof value === 'object' &&
  'type' in value &&
  value.type === 'field' &&
  'fieldId' in value &&
  typeof value.fieldId === 'string';

const isSourceFilterGroup = (
  value: ViewSourceFilterConditionDTO | ViewSourceFilterDTO
): value is ViewSourceFilterDTO => 'filterSet' in value;

const mapDateRange = (
  condition: ViewSourceFilterConditionDTO,
  operator: RecordFilterOperator
): RecordFilterNode | undefined => {
  const value = condition.value;
  if (
    (operator !== 'is' && operator !== 'isWithIn') ||
    value == null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !('mode' in value) ||
    value.mode !== 'dateRange'
  ) {
    return undefined;
  }

  return {
    conjunction: 'and',
    items: [
      {
        fieldId: condition.fieldId,
        operator: 'isOnOrAfter',
        value: {
          mode: 'exactDate',
          exactDate: value.exactDate,
          timeZone: value.timeZone,
        } as RecordFilterDateValue,
      },
      {
        fieldId: condition.fieldId,
        operator: 'isOnOrBefore',
        value: {
          mode: 'exactDate',
          exactDate: value.exactDateEnd,
          timeZone: value.timeZone,
        } as RecordFilterDateValue,
      },
    ],
  };
};

const mapCondition = (condition: ViewSourceFilterConditionDTO): RecordFilterNode | null => {
  const operator =
    condition.isSymbol === true
      ? sourceFilterSymbolOperatorMap.get(condition.operator)
      : condition.operator;
  if (!operator) return null;

  const dateRange = mapDateRange(condition, operator);
  if (dateRange) return dateRange;
  if (recordConditionOperatorsExpectingNull.includes(operator)) {
    return { fieldId: condition.fieldId, operator, value: null };
  }
  if (recordConditionOperatorsExpectingArray.includes(operator)) {
    if (condition.value == null) return null;
    const value =
      Array.isArray(condition.value) || isFieldReference(condition.value)
        ? condition.value
        : [condition.value];
    return {
      fieldId: condition.fieldId,
      operator,
      value: value as RecordFilterValue,
    };
  }
  if (condition.value == null && operator !== 'is' && operator !== 'isNot') return null;
  return {
    fieldId: condition.fieldId,
    operator,
    value: condition.value as RecordFilterValue,
  };
};

const mapGroup = (group: ViewSourceFilterDTO): RecordFilterNode => ({
  conjunction: group.conjunction,
  items: group.filterSet
    .map((item) => (isSourceFilterGroup(item) ? mapGroup(item) : mapCondition(item)))
    .filter((item): item is RecordFilterNode => item != null),
});

export class ViewSourceFilter extends ValueObject {
  private constructor(private readonly value: ViewSourceFilterDTO | null) {
    super();
  }

  static create(raw: unknown): Result<ViewSourceFilter, DomainError> {
    const parsed = viewSourceFilterSchema.safeParse(raw);
    if (!parsed.success) {
      return err(
        domainError.validation({
          message: 'Invalid ViewSourceFilter',
          details: z.formatError(parsed.error),
        })
      );
    }
    return ok(new ViewSourceFilter(parsed.data));
  }

  toDto(): ViewSourceFilterDTO | null {
    return viewSourceFilterSchema.parse(this.value);
  }

  toCanonical(): RecordFilter {
    return this.value == null ? null : mapGroup(this.value);
  }

  equals(other: ViewSourceFilter): boolean {
    return JSON.stringify(this.value) === JSON.stringify(other.value);
  }
}
