import { Injectable, HttpException, HttpStatus } from '@nestjs/common';
import { FieldKeyType, HttpErrorCode } from '@teable/core';
import type { IFieldVo, StatisticsFunc } from '@teable/core';
import type {
  IAggregationVo,
  IGroupPoint,
  IGroupPointsVo,
  IRowCountVo,
  ISearchCountRo,
  ISearchCountVo,
  ISearchIndexByQueryRo,
  ISearchIndexVo,
  IShareViewRowCountRo,
  IShareViewAggregationsRo,
  IShareViewGroupPointsRo,
  IShareViewCalendarDailyCollectionRo,
  ICalendarDailyCollectionVo,
  IShareViewLinkRecordsRo,
  IShareViewLinkRecordsVo,
  IShareViewCollaboratorsRo,
  IShareViewCollaboratorsVo,
  IShareViewCopyQuery,
  ICopyVo,
} from '@teable/openapi';
import { GroupPointType } from '@teable/openapi';
import {
  mapDomainErrorToHttpError,
  mapDomainErrorToHttpStatus,
  mapFieldToDto,
  mapTableRecordToDto,
} from '@teable/v2-contract-http';
import { executeListTableRecordsEndpoint } from '@teable/v2-contract-http-implementation/handlers';
import {
  AggregateTableRecordsQuery,
  type AggregateTableRecordsResult,
  GetCalendarDailyCollectionQuery,
  type GetCalendarDailyCollectionResult,
  GetViewLinkRecordsQuery,
  type GetViewLinkRecordsResult,
  GetViewCollaboratorsQuery,
  type GetViewCollaboratorsResult,
  GetViewSelectionCopyQuery,
  type GetViewSelectionCopyResult,
  type AttachmentValueDecoratorService,
  ListFieldsQuery,
  type ListFieldsResult,
  ListTableRecordsQuery,
  type ListTableRecordsResult,
  type IQueryBus,
  v2CoreTokens,
} from '@teable/v2-core';
import { CacheService } from '../../cache/cache.service';
import type { ICacheStore } from '../../cache/types';
import { type IThresholdConfig, ThresholdConfig } from '../../configs/threshold.config';
import { CustomHttpException, getDefaultCodeByStatus } from '../../custom.exception';
import { convertValueToStringify, string2Hash } from '../../utils';
import {
  normalizeLegacyRecordFilterForV2,
  type IRecordFilterFieldMeta,
} from '../record/open-api/record-filter-v2.mapper';
import { V2ContainerService } from '../v2/v2-container.service';
import { V2ExecutionContextFactory } from '../v2/v2-execution-context.factory';
import type { IShareViewInfo } from './share-auth.service';
import { isLinkRecordSelectionQuery } from './share-link-query.util';

const internalServerError = 'Internal server error';

type GroupPointMappingState = {
  previousValues: unknown[];
  collapsedDepth: number;
};

@Injectable()
export class SharedViewRecordQueryV2Service {
  constructor(
    private readonly v2ContainerService: V2ContainerService,
    private readonly v2ContextFactory: V2ExecutionContextFactory,
    @ThresholdConfig() private readonly thresholdConfig: IThresholdConfig,
    private readonly cacheService: CacheService<ICacheStore>
  ) {}

  async getAggregations(
    shareInfo: IShareViewInfo,
    query: IShareViewAggregationsRo = {}
  ): Promise<IAggregationVo> {
    if (!shareInfo.shareMeta?.includeRecords) return { aggregations: [] };
    const viewId = shareInfo.view?.id;
    if (!viewId) {
      throw new CustomHttpException('Shared view not found', HttpErrorCode.NOT_FOUND);
    }

    const { tableId } = shareInfo;
    const container = await this.v2ContainerService.getContainerForTable(tableId);
    const context = await this.v2ContextFactory.createContext(container);
    const queryBus = container.resolve<IQueryBus>(v2CoreTokens.queryBus);
    const filter = await this.normalizeFilter(
      tableId,
      query.filter,
      context.actorId.toString(),
      queryBus,
      context
    );
    const requestedFields = query.field
      ? Object.entries(query.field).flatMap(([statisticFunc, fieldIds]) =>
          fieldIds.map((fieldId) => ({ fieldId, statisticFunc }))
        )
      : undefined;
    const fields = requestedFields?.length ? requestedFields : undefined;
    const aggregationQuery = AggregateTableRecordsQuery.create(
      {
        tableId,
        viewId,
        filter,
        search: query.search,
        fields,
        groupBy: query.groupBy,
        includeHiddenFields: Boolean(shareInfo.shareMeta.includeHiddenField),
      },
      { maxGroupPoints: this.thresholdConfig.maxGroupPoints }
    );
    if (aggregationQuery.isErr()) this.throwDomainError(aggregationQuery.error);
    const result = await queryBus.execute<AggregateTableRecordsQuery, AggregateTableRecordsResult>(
      context,
      aggregationQuery.value
    );
    if (result.isErr()) this.throwDomainError(result.error);
    return this.mapAggregationResult(result.value, query);
  }

  async getGroupPoints(
    shareInfo: IShareViewInfo,
    query: IShareViewGroupPointsRo = {}
  ): Promise<IGroupPointsVo> {
    if (!shareInfo.shareMeta?.includeRecords) return [];
    const viewId = shareInfo.view?.id;
    if (!viewId) return null;
    const groupBy = query.groupBy?.slice(0, 3);
    if (!groupBy?.length) return [];

    const { tableId } = shareInfo;
    const container = await this.v2ContainerService.getContainerForTable(tableId);
    const context = await this.v2ContextFactory.createContext(container);
    const queryBus = container.resolve<IQueryBus>(v2CoreTokens.queryBus);
    const filter = await this.normalizeFilter(
      tableId,
      query.filter,
      context.actorId.toString(),
      queryBus,
      context
    );
    const aggregationQuery = AggregateTableRecordsQuery.create(
      {
        tableId,
        viewId,
        filter,
        search: query.search,
        fields: [{ fieldId: groupBy[0].fieldId, statisticFunc: 'count' }],
        groupBy,
        includeHiddenFields: Boolean(shareInfo.shareMeta.includeHiddenField),
      },
      { maxGroupPoints: this.thresholdConfig.maxGroupPoints }
    );
    if (aggregationQuery.isErr()) this.throwDomainError(aggregationQuery.error);
    const result = await queryBus.execute<AggregateTableRecordsQuery, AggregateTableRecordsResult>(
      context,
      aggregationQuery.value
    );
    if (result.isErr()) this.throwDomainError(result.error);
    const attachmentDecorator = container.resolve<AttachmentValueDecoratorService>(
      v2CoreTokens.attachmentValueDecoratorService
    );
    return this.mapGroupPointsResult(
      result.value,
      new Set(query.collapsedGroupIds),
      attachmentDecorator
    );
  }

  async getCalendarDailyCollection(
    shareInfo: IShareViewInfo,
    query: IShareViewCalendarDailyCollectionRo
  ): Promise<ICalendarDailyCollectionVo> {
    if (!shareInfo.shareMeta?.includeRecords) return { countMap: {}, records: [] };
    const viewId = shareInfo.view?.id;
    if (!viewId) {
      throw new CustomHttpException('Shared view not found', HttpErrorCode.NOT_FOUND);
    }

    const { tableId } = shareInfo;
    const container = await this.v2ContainerService.getContainerForTable(tableId);
    const context = await this.v2ContextFactory.createContext(container);
    const queryBus = container.resolve<IQueryBus>(v2CoreTokens.queryBus);
    const filter = await this.normalizeFilter(
      tableId,
      query.filter,
      context.actorId.toString(),
      queryBus,
      context
    );
    const calendarQuery = GetCalendarDailyCollectionQuery.create({
      tableId,
      viewId,
      startDate: query.startDate,
      endDate: query.endDate,
      startDateFieldId: query.startDateFieldId,
      endDateFieldId: query.endDateFieldId,
      filter,
      search: query.search,
      includeHiddenFields: Boolean(shareInfo.shareMeta.includeHiddenField),
    });
    if (calendarQuery.isErr()) this.throwDomainError(calendarQuery.error);
    const result = await queryBus.execute<
      GetCalendarDailyCollectionQuery,
      GetCalendarDailyCollectionResult
    >(context, calendarQuery.value);
    if (result.isErr()) this.throwDomainError(result.error);

    const records = result.value.records.map((record) => {
      const dto = mapTableRecordToDto(record);
      if (dto.isErr()) this.throwDomainError(dto.error);
      return dto.value;
    });
    return { countMap: { ...result.value.countMap }, records };
  }

  async getLinkRecords(
    shareInfo: IShareViewInfo,
    query: IShareViewLinkRecordsRo
  ): Promise<IShareViewLinkRecordsVo> {
    const viewId = shareInfo.view?.id;
    if (!viewId) {
      throw new CustomHttpException('Shared view not found', HttpErrorCode.NOT_FOUND);
    }

    const { tableId } = shareInfo;
    const container = await this.v2ContainerService.getContainerForTable(tableId);
    const context = await this.v2ContextFactory.createContext(container);
    const queryBus = container.resolve<IQueryBus>(v2CoreTokens.queryBus);
    const planQuery = GetViewLinkRecordsQuery.create({
      tableId,
      viewId,
      fieldId: query.fieldId,
      requestType: query.type,
      includeHiddenFields: Boolean(shareInfo.shareMeta?.includeHiddenField),
      search: query.search,
      take: query.take ?? 100,
      skip: query.skip ?? 0,
    });
    if (planQuery.isErr()) this.throwDomainError(planQuery.error);

    const planResult = await queryBus.execute<GetViewLinkRecordsQuery, GetViewLinkRecordsResult>(
      context,
      planQuery.value
    );
    if (planResult.isErr()) this.throwDomainError(planResult.error);
    return [...planResult.value.records];
  }

  async getCollaborators(
    shareInfo: IShareViewInfo,
    query: IShareViewCollaboratorsRo,
    canReadAllCollaborators: boolean
  ): Promise<IShareViewCollaboratorsVo> {
    const { tableId } = shareInfo;
    const container = await this.v2ContainerService.getContainerForTable(tableId);
    const context = await this.v2ContextFactory.createContext(container);
    const queryBus = container.resolve<IQueryBus>(v2CoreTokens.queryBus);
    const collaboratorsQuery = GetViewCollaboratorsQuery.create({
      tableId,
      viewId: shareInfo.view?.id,
      fieldId: query.fieldId,
      includeHiddenFields: Boolean(shareInfo.shareMeta?.includeHiddenField),
      canReadAllCollaborators,
      search: query.search,
      take: query.take ?? 50,
      skip: query.skip ?? 0,
    });
    if (collaboratorsQuery.isErr()) this.throwDomainError(collaboratorsQuery.error);
    const result = await queryBus.execute<GetViewCollaboratorsQuery, GetViewCollaboratorsResult>(
      context,
      collaboratorsQuery.value
    );
    if (result.isErr()) this.throwDomainError(result.error);
    return [...result.value.collaborators];
  }

  async getCopy(
    shareInfo: IShareViewInfo,
    query: IShareViewCopyQuery,
    canCopyAsEditor: boolean
  ): Promise<ICopyVo> {
    const viewId = shareInfo.view?.id;
    if (!viewId) {
      throw new CustomHttpException('Shared view not found', HttpErrorCode.NOT_FOUND);
    }

    const { tableId } = shareInfo;
    const container = await this.v2ContainerService.getContainerForTable(tableId);
    const context = await this.v2ContextFactory.createContext(container);
    const queryBus = container.resolve<IQueryBus>(v2CoreTokens.queryBus);
    const filter = await this.normalizeFilter(
      tableId,
      query.filter,
      context.actorId.toString(),
      queryBus,
      context
    );
    const collapsedGroupIds = await this.resolveCopyCollapsedGroupIds(query);
    const copyQuery = GetViewSelectionCopyQuery.create(
      {
        tableId,
        viewId,
        canCopyAsEditor,
        ranges: query.ranges,
        type: query.type,
        projection: query.projection,
        filter,
        orderBy: query.orderBy,
        groupBy: query.groupBy,
        search: query.search,
        collapsedGroupIds,
      },
      {
        maxCopyCells: this.thresholdConfig.maxCopyCells,
        maxGroupPoints: this.thresholdConfig.maxGroupPoints,
      }
    );
    if (copyQuery.isErr()) this.throwDomainError(copyQuery.error);
    const result = await queryBus.execute<GetViewSelectionCopyQuery, GetViewSelectionCopyResult>(
      context,
      copyQuery.value
    );
    if (result.isErr()) this.throwDomainError(result.error);

    const header: IFieldVo[] = result.value.fields.map((field) => {
      const fieldDto = mapFieldToDto(field, result.value.primaryFieldId);
      if (fieldDto.isErr()) this.throwDomainError(fieldDto.error);
      return fieldDto.value as IFieldVo;
    });
    return { content: result.value.content, header };
  }

  private async resolveCopyCollapsedGroupIds(
    query: IShareViewCopyQuery
  ): Promise<ReadonlyArray<string> | undefined> {
    if (!query.queryId) return query.collapsedGroupIds;

    const cache = await this.cacheService.get(`query-params:${query.queryId}`);
    if (!cache) return query.collapsedGroupIds;
    const nestedQueryParams =
      cache.queryParams != null &&
      typeof cache.queryParams === 'object' &&
      !Array.isArray(cache.queryParams)
        ? (cache.queryParams as Record<string, unknown>)
        : undefined;
    const collapsedGroupIds = (nestedQueryParams ?? cache).collapsedGroupIds;
    return Array.isArray(collapsedGroupIds) &&
      collapsedGroupIds.every((groupId): groupId is string => typeof groupId === 'string')
      ? collapsedGroupIds
      : query.collapsedGroupIds;
  }

  private mapAggregationResult(
    result: AggregateTableRecordsResult,
    query: IShareViewAggregationsRo
  ): IAggregationVo {
    const aggregations: NonNullable<IAggregationVo['aggregations']> = result.values
      .filter((value) => value.groupValues === undefined)
      .map((value) => ({
        fieldId: value.fieldId.toString(),
        total: { value: value.value, aggFunc: value.statisticFunc as StatisticsFunc },
      }));
    const aggregationByKey = new Map(
      aggregations.map((aggregation) => [
        `${aggregation.fieldId}:${aggregation.total!.aggFunc}`,
        aggregation,
      ])
    );

    for (const value of result.values) {
      if (!value.groupValues?.length) continue;
      const currentGroup = query.groupBy?.[value.groupValues.length - 1];
      if (!currentGroup) continue;
      const groupValue = value.groupValues.map(convertValueToStringify).join('_');
      const groupId = String(string2Hash(`${currentGroup.fieldId}_${groupValue}`));
      const aggregation = aggregationByKey.get(
        `${value.fieldId.toString()}:${value.statisticFunc}`
      );
      if (!aggregation) continue;
      aggregation.group ??= {};
      aggregation.group[groupId] = {
        value: value.value,
        aggFunc: value.statisticFunc as StatisticsFunc,
      };
    }

    return { aggregations };
  }

  private async mapGroupPointsResult(
    result: AggregateTableRecordsResult,
    collapsedGroupIds: ReadonlySet<string>,
    attachmentDecorator: AttachmentValueDecoratorService
  ): Promise<IGroupPointsVo> {
    const depth = result.groupBy.length;
    if (!depth) return [];
    const total =
      Number(
        result.values.find(
          (value) => value.statisticFunc === 'count' && value.groupValues === undefined
        )?.value
      ) || 0;
    const rows = result.values.filter(
      (value) => value.statisticFunc === 'count' && value.groupValues?.length === depth
    );
    const groupPoints: IGroupPoint[] = [];
    const state: GroupPointMappingState = {
      previousValues: Array.from({ length: depth }, () => Symbol()),
      collapsedDepth: Number.MAX_SAFE_INTEGER,
    };
    let groupedRowCount = 0;

    for (const row of rows) {
      await this.appendGroupHeaders(
        result,
        row.groupValues!,
        collapsedGroupIds,
        attachmentDecorator,
        state,
        groupPoints
      );

      const count = Number(row.value) || 0;
      groupedRowCount += count;
      if (state.collapsedDepth === Number.MAX_SAFE_INTEGER) {
        groupPoints.push({ type: GroupPointType.Row, count });
      }
    }

    if (groupedRowCount < total) {
      groupPoints.push(
        {
          id: 'unknown',
          type: GroupPointType.Header,
          depth: 0,
          value: 'Unknown',
          isCollapsed: false,
        },
        { type: GroupPointType.Row, count: total - groupedRowCount }
      );
    }
    return groupPoints;
  }

  private async appendGroupHeaders(
    result: AggregateTableRecordsResult,
    rawGroupValues: ReadonlyArray<unknown>,
    collapsedGroupIds: ReadonlySet<string>,
    attachmentDecorator: AttachmentValueDecoratorService,
    state: GroupPointMappingState,
    groupPoints: IGroupPoint[]
  ): Promise<void> {
    for (let index = 0; index < rawGroupValues.length; index++) {
      const rawValue = rawGroupValues[index];
      const stringifiedValue = convertValueToStringify(rawValue);
      if (state.previousValues[index] === stringifiedValue) continue;

      const group = result.groupBy[index]!;
      const groupId = String(
        string2Hash(
          `${group.fieldId.toString()}_${[
            ...state.previousValues.slice(0, index),
            stringifiedValue,
          ].join('_')}`
        )
      );
      if (index > state.collapsedDepth) break;

      state.collapsedDepth = Number.MAX_SAFE_INTEGER;
      state.previousValues[index] = stringifiedValue;
      state.previousValues = state.previousValues.map((value, valueIndex) =>
        valueIndex > index ? Symbol() : value
      );
      const isCollapsed = collapsedGroupIds.has(groupId);
      const value =
        group.fieldType === 'attachment'
          ? await this.decorateAttachmentGroupValue(rawValue, attachmentDecorator)
          : rawValue;
      groupPoints.push({
        id: groupId,
        type: GroupPointType.Header,
        depth: index,
        value,
        isCollapsed,
      });
      if (isCollapsed) state.collapsedDepth = index;
    }
  }

  private async decorateAttachmentGroupValue(
    value: unknown,
    attachmentDecorator: AttachmentValueDecoratorService
  ): Promise<unknown> {
    const result = await attachmentDecorator.decorateAttachmentValue(value);
    if (result.isErr()) this.throwDomainError(result.error);
    return result.value;
  }

  async getSearchCount(shareInfo: IShareViewInfo, query: ISearchCountRo): Promise<ISearchCountVo> {
    if (!query.search) {
      throw new CustomHttpException('Search query is required', HttpErrorCode.VALIDATION_ERROR, {
        localization: {
          i18nKey: 'httpErrors.aggregation.searchQueryRequired',
        },
      });
    }

    const [searchValue, searchFieldKeys] = query.search;
    const result = await this.getRowCount(shareInfo, {
      filter: query.filter,
      search: [searchValue, searchFieldKeys ?? '', true],
    });
    return { count: result.rowCount };
  }

  async getSearchIndex(
    shareInfo: IShareViewInfo,
    query: ISearchIndexByQueryRo
  ): Promise<ISearchIndexVo> {
    const [searchValue, searchFieldKeys, hideNotMatchRow] = this.validateSearchIndexQuery(query);
    if (!shareInfo.shareMeta?.includeRecords) return null;

    const { tableId, view, linkOptions } = shareInfo;
    const container = await this.v2ContainerService.getContainerForTable(tableId);
    const context = await this.v2ContextFactory.createContext(container);
    const queryBus = container.resolve<IQueryBus>(v2CoreTokens.queryBus);
    const isLinkSelectionQuery = Boolean(linkOptions) && isLinkRecordSelectionQuery(query);
    const viewId = isLinkSelectionQuery ? view?.id : linkOptions?.filterByViewId ?? view?.id;
    const rawFilter = isLinkSelectionQuery ? undefined : query.filter ?? linkOptions?.filter;
    const filter = await this.normalizeFilter(
      tableId,
      rawFilter,
      context.actorId.toString(),
      queryBus,
      context
    );
    const sort = [...(query.groupBy ?? []), ...(query.orderBy ?? [])].map((item) => ({
      fieldId: item.fieldId,
      order: item.order,
    }));
    const listQuery = ListTableRecordsQuery.create(
      {
        tableId,
        fieldKeyType: FieldKeyType.Id,
        limit: query.take,
        offset: query.skip ?? 0,
        includeTotal: false,
        search: [searchValue, searchFieldKeys ?? '', true],
        viewId,
        ignoreViewQuery: isLinkSelectionQuery || undefined,
        filter,
        sort: sort.length ? sort : undefined,
        groupBy: query.groupBy?.map((item) => item.fieldId),
        projection: query.projection,
        filterLinkCellSelected: query.filterLinkCellSelected,
        filterLinkCellCandidate: query.filterLinkCellCandidate,
        selectedRecordIds: query.selectedRecordIds,
      },
      {
        includeSearchFieldMatches: true,
        searchIndexMode: hideNotMatchRow ? 'matched' : 'view',
      }
    );
    if (listQuery.isErr()) this.throwDomainError(listQuery.error);
    const result = await queryBus.execute<ListTableRecordsQuery, ListTableRecordsResult>(
      context,
      listQuery.value
    );
    if (result.isErr()) this.throwDomainError(result.error);
    return this.mapSearchIndexResult(result.value.searchMatches);
  }

  private validateSearchIndexQuery(query: ISearchIndexByQueryRo) {
    if (query.take > 1000) {
      throw new CustomHttpException(
        'The maximum search index result is 1000',
        HttpErrorCode.VALIDATION_ERROR,
        {
          localization: {
            i18nKey: 'httpErrors.aggregation.maxSearchIndexResult',
          },
        }
      );
    }
    if (!query.search) {
      throw new CustomHttpException('Search query is required', HttpErrorCode.VALIDATION_ERROR, {
        localization: {
          i18nKey: 'httpErrors.aggregation.searchQueryRequired',
        },
      });
    }
    return query.search;
  }

  private mapSearchIndexResult(matches: ListTableRecordsResult['searchMatches']): ISearchIndexVo {
    if (!matches?.length) return null;
    return matches.map((match) => ({
      index: match.index,
      fieldId: match.fieldId.toString(),
      recordId: match.recordId.toString(),
    }));
  }

  // eslint-disable-next-line sonarjs/cognitive-complexity
  async getRowCount(
    shareInfo: IShareViewInfo,
    query: IShareViewRowCountRo = {}
  ): Promise<IRowCountVo> {
    const { tableId, view, linkOptions, shareMeta } = shareInfo;
    if (!shareMeta?.includeRecords) {
      return { rowCount: 0 };
    }

    const container = await this.v2ContainerService.getContainerForTable(tableId);
    const context = await this.v2ContextFactory.createContext(container);
    const queryBus = container.resolve<IQueryBus>(v2CoreTokens.queryBus);

    const isLinkSelectionQuery = Boolean(linkOptions) && isLinkRecordSelectionQuery(query);
    const viewId = isLinkSelectionQuery ? view?.id : linkOptions?.filterByViewId ?? view?.id;
    const rawFilter = isLinkSelectionQuery ? undefined : linkOptions?.filter ?? query.filter;
    const filter = await this.normalizeFilter(
      tableId,
      rawFilter,
      context.actorId.toString(),
      queryBus,
      context
    );

    const result = await executeListTableRecordsEndpoint(
      context,
      {
        tableId,
        fieldKeyType: FieldKeyType.Id,
        limit: 1,
        offset: 0,
        projection: [],
        includeTotal: true,
        ...(viewId ? { viewId } : {}),
        ...(isLinkSelectionQuery ? { ignoreViewQuery: true } : {}),
        ...(filter ? { filter } : {}),
        ...(query.search ? { search: query.search } : {}),
        ...(query.filterLinkCellSelected
          ? { filterLinkCellSelected: query.filterLinkCellSelected }
          : {}),
        ...(query.filterLinkCellCandidate
          ? { filterLinkCellCandidate: query.filterLinkCellCandidate }
          : {}),
        ...(query.selectedRecordIds?.length ? { selectedRecordIds: query.selectedRecordIds } : {}),
      },
      queryBus
    );

    if (result.status === 200 && result.body.ok) {
      return { rowCount: result.body.data.pagination.total };
    }
    if (!result.body.ok) {
      this.throwV2Error(result.body.error, result.status);
    }
    throw new HttpException(internalServerError, HttpStatus.INTERNAL_SERVER_ERROR);
  }

  private async normalizeFilter(
    tableId: string,
    rawFilter: unknown,
    actorId: string,
    queryBus: IQueryBus,
    context: Parameters<IQueryBus['execute']>[0]
  ) {
    if (rawFilter == null) return rawFilter;

    const queryResult = ListFieldsQuery.create({ tableId });
    if (queryResult.isErr()) {
      this.throwDomainError(queryResult.error);
    }
    const fieldsResult = await queryBus.execute<ListFieldsQuery, ListFieldsResult>(
      context,
      queryResult.value
    );
    if (fieldsResult.isErr()) {
      this.throwDomainError(fieldsResult.error);
    }

    const fieldMetaById = new Map<string, IRecordFilterFieldMeta>();
    for (const field of fieldsResult.value.fields) {
      const fieldDto = mapFieldToDto(field, fieldsResult.value.primaryFieldId);
      if (fieldDto.isErr()) {
        this.throwDomainError(fieldDto.error);
      }
      fieldMetaById.set(fieldDto.value.id, {
        type: fieldDto.value.type,
        cellValueType: 'cellValueType' in fieldDto.value ? fieldDto.value.cellValueType : undefined,
        options: fieldDto.value.options,
      });
    }

    const normalized = normalizeLegacyRecordFilterForV2(rawFilter, fieldMetaById, actorId);
    if (normalized.isErr()) {
      this.throwDomainError(normalized.error);
    }
    return normalized.value;
  }

  private throwDomainError(error: Parameters<typeof mapDomainErrorToHttpError>[0]): never {
    this.throwV2Error(mapDomainErrorToHttpError(error), mapDomainErrorToHttpStatus(error));
  }

  private throwV2Error(
    error: {
      code: string;
      message: string;
      tags?: ReadonlyArray<string>;
      details?: Readonly<Record<string, unknown>>;
    },
    status: number
  ): never {
    throw new CustomHttpException(error.message, getDefaultCodeByStatus(status), {
      domainCode: error.code,
      domainTags: error.tags,
      details: error.details,
    });
  }
}
