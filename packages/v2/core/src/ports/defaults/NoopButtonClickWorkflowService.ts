import { ok } from 'neverthrow';
import type { Result } from 'neverthrow';

import type { DomainError } from '../../domain/shared/DomainError';
import type { ButtonClicked } from '../../domain/table/events/ButtonClicked';
import type {
  ButtonClickWorkflowResult,
  IButtonClickWorkflowService,
} from '../ButtonClickWorkflowService';
import type { IExecutionContext } from '../ExecutionContext';

export class NoopButtonClickWorkflowService implements IButtonClickWorkflowService {
  async trigger(
    _context: IExecutionContext,
    _event: ButtonClicked
  ): Promise<Result<ButtonClickWorkflowResult, DomainError>> {
    return ok({ runId: '' });
  }
}
