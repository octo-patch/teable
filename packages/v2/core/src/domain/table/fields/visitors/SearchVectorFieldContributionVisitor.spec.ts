import { describe, expect, it } from 'vitest';

import { FieldId } from '../FieldId';
import { FieldName } from '../FieldName';
import { AttachmentField } from '../types/AttachmentField';
import { CheckboxField } from '../types/CheckboxField';
import { DateField } from '../types/DateField';
import { LongTextField } from '../types/LongTextField';
import { MultipleSelectField } from '../types/MultipleSelectField';
import { NumberField } from '../types/NumberField';
import { SelectOption } from '../types/SelectOption';
import { SingleLineTextField } from '../types/SingleLineTextField';
import { UserField } from '../types/UserField';
import { UserMultiplicity } from '../types/UserMultiplicity';
import { SearchVectorFieldContributionVisitor } from './SearchVectorFieldContributionVisitor';

const fieldId = (value: string) => FieldId.create(value)._unsafeUnwrap();
const fieldName = (value: string) => FieldName.create(value)._unsafeUnwrap();

describe('SearchVectorFieldContributionVisitor', () => {
  const visitor = new SearchVectorFieldContributionVisitor();

  it.each([
    {
      name: 'single line text',
      field: SingleLineTextField.create({
        id: fieldId('fld0000000000000001'),
        name: fieldName('Title'),
      })._unsafeUnwrap(),
      expected: { included: true, textProjection: { kind: 'plain' } },
    },
    {
      name: 'long text',
      field: LongTextField.create({
        id: fieldId('fld0000000000000002'),
        name: fieldName('Notes'),
      })._unsafeUnwrap(),
      expected: { included: true, textProjection: { kind: 'multiline' } },
    },
    {
      name: 'number',
      field: NumberField.create({
        id: fieldId('fld0000000000000003'),
        name: fieldName('Amount'),
      })._unsafeUnwrap(),
      expected: { included: true, textProjection: { kind: 'rounded_number', precision: 2 } },
    },
    {
      name: 'checkbox',
      field: CheckboxField.create({
        id: fieldId('fld0000000000000004'),
        name: fieldName('Done'),
      })._unsafeUnwrap(),
      expected: { included: false, skippedReason: 'non_text_value' },
    },
    {
      name: 'date',
      field: DateField.create({
        id: fieldId('fld0000000000000005'),
        name: fieldName('Due'),
      })._unsafeUnwrap(),
      expected: { included: false, skippedReason: 'non_text_value' },
    },
    {
      name: 'single user',
      field: UserField.create({
        id: fieldId('fld0000000000000006'),
        name: fieldName('Owner'),
      })._unsafeUnwrap(),
      expected: { included: true, textProjection: { kind: 'structured_title' } },
    },
    {
      name: 'multiple user',
      field: UserField.create({
        id: fieldId('fld0000000000000007'),
        name: fieldName('Collaborators'),
        isMultiple: UserMultiplicity.multiple(),
      })._unsafeUnwrap(),
      expected: { included: true, textProjection: { kind: 'structured_title_list' } },
    },
    {
      name: 'multiple select',
      field: MultipleSelectField.create({
        id: fieldId('fld0000000000000008'),
        name: fieldName('Tags'),
        options: [SelectOption.create({ name: 'Alpha', color: 'blue' })._unsafeUnwrap()],
      })._unsafeUnwrap(),
      expected: { included: true, textProjection: { kind: 'plain_list' } },
    },
    {
      name: 'attachment',
      field: AttachmentField.create({
        id: fieldId('fld0000000000000009'),
        name: fieldName('Files'),
      })._unsafeUnwrap(),
      expected: { included: true, textProjection: { kind: 'structured_title_list' } },
    },
  ])('$name has an explicit contribution decision', ({ field, expected }) => {
    const result = field.accept(visitor)._unsafeUnwrap();

    expect(result).toMatchObject(expected);
    expect(result.fieldId).toBe(field.id().toString());
    expect(result.fieldType).toBe(field.type().toString());
  });
});
