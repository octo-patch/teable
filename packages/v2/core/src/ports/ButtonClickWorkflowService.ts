import type { Result } from 'neverthrow';

import type { DomainError } from '../domain/shared/DomainError';
import type { ButtonClicked } from '../domain/table/events/ButtonClicked';
import type { IExecutionContext } from './ExecutionContext';

export type ButtonClickWorkflowResult = Readonly<{
  runId: string;
}>;

/**
 * Application boundary for running the workflow selected by a Table-owned Button field.
 *
 * Core emits the ButtonClicked event after the aggregate mutation is committed. Enterprise
 * automation can implement this port without leaking workflow infrastructure into Table.
 */
export interface IButtonClickWorkflowService {
  trigger(
    context: IExecutionContext,
    event: ButtonClicked
  ): Promise<Result<ButtonClickWorkflowResult, DomainError>>;
}
