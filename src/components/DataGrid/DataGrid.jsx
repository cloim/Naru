import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AgGridReact } from 'ag-grid-react';
import { ModuleRegistry, AllCommunityModule } from 'ag-grid-community';
import { ColumnFilterHeader } from './ColumnFilterHeader.jsx';
import { cn, tw } from '../../tw.js';

ModuleRegistry.registerModules([AllCommunityModule]);

// AG Grid 바깥 테두리(좌우 1px). 최소 폭에 넣지 않으면 안쪽 영역이 2px 넘쳐 터치 가로 스크롤을 먼저 가로챈다.
const GRID_BORDER_WIDTH = 2;

export function DataGrid({
  rowData,
  columnDefs,
  getRowId,
  onRowClicked,
  onSortChange,
  initialSortState = null,
  initialFirstRowIndex = 0,
  onFirstDisplayedRowChange,
  // 컬럼 필터와 사용자 정렬까지 적용된 "지금 화면에 보이는 행"을 보이는 순서 그대로
  // 넘겨준다. 엑셀 내보내기가 화면과 같은 결과를 내려면 이 값을 써야 한다.
  onDisplayedRowsChange,
  isLoading = false,
  errorMessage = '',
  emptyMessage = '조건에 맞는 데이터가 없습니다.',
  headerHeight = 44,
  rowHeight = 52,
  className = '',
  ...gridProps
}) {
  const [sortState, setSortState] = useState(initialSortState);
  const gridApiRef = useRef(null);
  // 엑셀 스타일 컬럼 필터 상태. { [field]: FilterState | undefined } — 키가 없으면 "필터
  // 없음"(전체 표시). FilterState는 둘 중 하나:
  //   - { mode: 'values', selection: Set<string> }        값 목록 체크박스 선택
  //   - { mode: 'condition', op, value }                   조건 필터(포함/이상/초과/이하/미만)
  // 값 목록을 계산할 때는 다른 컬럼의 필터만 적용된 행 기준으로 계산한다(엑셀과 동일한 동작 —
  // 자기 자신의 필터는 값 목록에 영향을 주지 않아야 모든 값이 계속 보인다).
  const [columnFilters, setColumnFilters] = useState({});

  // filterable 컬럼만 모은 맵(field -> colDef). filterValuesGetter는 한 셀의 개별 배지처럼
  // 여러 값을, filterValueGetter는 가공된 단일 값을 제공한다. 둘 다 없으면 row[field]를 쓴다.
  const filterableColumnsByField = useMemo(() => {
    const map = new Map();
    if (Array.isArray(columnDefs)) {
      columnDefs
        .filter((col) => col.filterable)
        .forEach((col) => map.set(col.field ?? col.colId, col));
    }
    return map;
  }, [columnDefs]);

  const filterableFields = useMemo(
    () => Array.from(filterableColumnsByField.keys()),
    [filterableColumnsByField],
  );

  const getFilterValues = useCallback(
    (field, row) => {
      const colDef = filterableColumnsByField.get(field);
      if (colDef?.filterValuesGetter) {
        const rawValues = colDef.filterValuesGetter(row);
        if (!Array.isArray(rawValues)) {
          throw new Error(`DataGrid filterValuesGetter는 배열을 반환해야 합니다: ${field}`);
        }
        const values = [...new Set(rawValues.map(formatFilterValue))];
        return values.length > 0 ? values : [''];
      }
      const rawValue = colDef?.filterValueGetter
        ? colDef.filterValueGetter(row)
        : colDef?.valueGetter
          ? colDef.valueGetter({ data: row })
          : row[field];
      return [formatFilterValue(rawValue)];
    },
    [filterableColumnsByField],
  );

  const matchesFilter = useCallback(
    (filterState, value) => matchesFilterState(filterState, value),
    [],
  );

  const applyColumnFilters = useCallback(
    (rows, excludeField) =>
      (rows || []).filter((row) =>
        filterableFields.every((field) => {
          if (field === excludeField) {
            return true;
          }
          const filterState = columnFilters[field];
          if (!filterState) {
            return true;
          }
          return getFilterValues(field, row).some((value) => matchesFilter(filterState, value));
        }),
      ),
    [filterableFields, columnFilters, getFilterValues, matchesFilter],
  );

  const columnFilterApi = useMemo(
    () => ({
      isActive: (field) => Boolean(columnFilters[field]),
      getFilterState: (field) => columnFilters[field] ?? null,
      getOptions: (field) => {
        const baseRows = applyColumnFilters(rowData, field);
        const counts = new Map();
        for (const row of baseRows) {
          for (const value of getFilterValues(field, row)) {
            const entry = counts.get(value);
            if (entry) {
              entry.count += 1;
            } else {
              counts.set(value, { value, label: value || '(비어 있음)', count: 1 });
            }
          }
        }
        return Array.from(counts.values()).sort((a, b) => a.label.localeCompare(b.label, 'ko'));
      },
      setFilter: (field, filterState) => {
        setColumnFilters((current) => {
          if (!filterState) {
            const next = { ...current };
            delete next[field];
            return next;
          }
          return { ...current, [field]: filterState };
        });
      },
    }),
    [columnFilters, rowData, applyColumnFilters, getFilterValues],
  );

  const filteredRowData = useMemo(
    () => (filterableFields.length === 0 ? rowData : applyColumnFilters(rowData, null)),
    [rowData, filterableFields, applyColumnFilters],
  );

  // suppressRepeat를 켠 컬럼의 키를 columnDefs 순서대로 모은다. 이 순서가 곧 반복값 억제의
  // 계층(상위 → 하위)이 된다.
  const suppressRepeatKeys = useMemo(() => {
    if (!Array.isArray(columnDefs)) return [];
    return columnDefs
      .filter((col) => col.suppressRepeat)
      .map((col) => col.colId ?? col.field)
      .filter(Boolean);
  }, [columnDefs]);

  // 화면 맨 위에 온전히 보이는 행의 인덱스. 이 행은 그룹 중간이라도 값을 다시 보여준다.
  // 셀 렌더러는 columnDefs가 그대로면 다시 만들어지지 않으므로 state 대신 ref로 전달한다.
  const anchorRowIndexRef = useRef(0);

  // 스크롤이나 행 구성 변화로 기준 행이 바뀌었는지 확인하고 기억한다. 실제로 바뀐 경우에만
  // true를 돌려주어, 스크롤할 때마다 셀을 다시 그리는 낭비를 막는다.
  const syncAnchorRow = useCallback(
    (api) => {
      if (suppressRepeatKeys.length === 0) return false;
      const nextAnchor = resolveAnchorRowIndex(api);
      if (nextAnchor === anchorRowIndexRef.current) return false;
      anchorRowIndexRef.current = nextAnchor;
      return true;
    },
    [suppressRepeatKeys],
  );

  // filterable 컬럼에만 필터 버튼이 달린 커스텀 헤더를 끼우고, suppressRepeat 컬럼에는 반복값을
  // 가리는 셀 렌더러를 씌운다.
  const effectiveColumnDefs = useMemo(() => {
    if (!Array.isArray(columnDefs)) return columnDefs;
    return columnDefs.map((col) => {
      let next = col;
      if (col.filterable) {
        next = { ...next, headerComponent: ColumnFilterHeader };
      }
      if (col.suppressRepeat) {
        const key = col.colId ?? col.field;
        // 자기 자신까지 포함한 상위 계층 키들. 이 값들이 모두 이전 행과 같아야 숨긴다.
        const groupKeys = suppressRepeatKeys.slice(0, suppressRepeatKeys.indexOf(key) + 1);
        next = {
          ...next,
          cellRenderer: createSuppressRepeatRenderer(
            groupKeys,
            col.cellRenderer,
            anchorRowIndexRef,
          ),
        };
      }
      return next;
    });
  }, [columnDefs, suppressRepeatKeys]);

  const gridContext = useMemo(() => ({ columnFilterApi }), [columnFilterApi]);

  const defaultColDef = useMemo(
    () => ({
      resizable: false,
      sortable: true,
      suppressMovable: true,
      tooltipValueGetter: (params) => {
        const val = params.valueFormatted ?? params.value;
        if (val == null || val === '' || val === '-') return undefined;
        return String(val);
      },
    }),
    [],
  );

  const handleSortChanged = useCallback(
    (event) => {
      const sortedColumn = event.api.getColumnState().find((column) => column.sort);
      let nextSortState = null;
      if (sortedColumn) {
        const column = event.api.getColumn(sortedColumn.colId);
        nextSortState = {
          colId: sortedColumn.colId,
          headerName: column?.getColDef().headerName ?? '',
          direction: sortedColumn.sort,
        };
      }
      setSortState(nextSortState);
      onSortChange?.(nextSortState);
    },
    [onSortChange],
  );

  const onGridReady = useCallback(
    (event) => {
      gridApiRef.current = event.api;
      if (initialSortState?.colId && initialSortState?.direction) {
        event.api.applyColumnState({
          state: [{ colId: initialSortState.colId, sort: initialSortState.direction }],
          defaultState: { sort: null },
        });
      }
      if (initialFirstRowIndex > 0) {
        window.setTimeout(() => event.api.ensureIndexVisible(initialFirstRowIndex, 'top'), 0);
      }
    },
    [initialFirstRowIndex, initialSortState],
  );

  const handleBodyScroll = useCallback(
    (event) => {
      if (event.direction === 'vertical') {
        onFirstDisplayedRowChange?.(event.api.getFirstDisplayedRowIndex());
        if (syncAnchorRow(event.api)) {
          event.api.refreshCells({ columns: suppressRepeatKeys, force: true });
        }
      }
    },
    [onFirstDisplayedRowChange, suppressRepeatKeys, syncAnchorRow],
  );

  // 스크롤 외에 창 크기 변화나 행 재구성으로 보이는 범위가 달라질 때도 기준 행을 다시 잡는다.
  // 기준 행이 실제로 바뀐 경우에만 갱신하므로 이 안의 refreshCells가 이벤트를 되부르지 않는다.
  const handleViewportChanged = useCallback(
    (event) => {
      if (syncAnchorRow(event.api)) {
        event.api.refreshCells({ columns: suppressRepeatKeys, force: true });
      }
    },
    [suppressRepeatKeys, syncAnchorRow],
  );

  // 필터와 정렬이 적용된 표시 행을 그 순서대로 꺼낸다. AG Grid 내부 상태(컬럼 필터, 헤더
  // 정렬)는 rowData에 반영되지 않으므로, 내보내기가 화면과 어긋나지 않으려면 그리드에서
  // 직접 읽어야 한다.
  const handleModelUpdated = useCallback(
    (event) => {
      // 반복값 억제는 "바로 위 행"과 "화면 맨 위 행"을 기준으로 하므로 정렬이나 필터로 행 순서가
      // 바뀌면 결과도 달라진다. AG Grid는 값이 그대로인 셀을 다시 그리지 않으니 강제로 갱신한다.
      if (suppressRepeatKeys.length > 0) {
        syncAnchorRow(event.api);
        event.api.refreshCells({ columns: suppressRepeatKeys, force: true });
      }
      if (!onDisplayedRowsChange) return;
      const rows = [];
      event.api.forEachNodeAfterFilterAndSort((node) => {
        if (node.data) rows.push(node.data);
      });
      onDisplayedRowsChange(rows);
    },
    [onDisplayedRowsChange, suppressRepeatKeys, syncAnchorRow],
  );

  // AG Grid의 커스텀 headerComponent(ColumnFilterHeader)는 React state 변경을 자동으로
  // 감지해 다시 그리지 않는다(context prop이 바뀌어도 그리드가 헤더를 리렌더링해주지 않음).
  // 필터를 적용한 뒤 팝업을 다시 열면 이전 선택 상태와 활성 표시가 반영되지 않는 문제가 있어,
  // columnFilters가 바뀔 때마다 refreshHeader()로 모든 헤더 컴포넌트를 강제로 다시 그린다.
  useEffect(() => {
    gridApiRef.current?.refreshHeader();
  }, [columnFilters]);

  const [userResizedWidth, setUserResizedWidth] = useState(0);
  const initialMinWidth = useMemo(() => {
    let sum = 0;
    if (gridProps.rowSelection) {
      const selCol = gridProps.selectionColumnDef;
      sum += selCol?.width ?? selCol?.minWidth ?? 50;
    }
    if (Array.isArray(columnDefs)) {
      for (const column of columnDefs) {
        if (typeof column.width === 'number') {
          sum += column.width;
        } else if (typeof column.minWidth === 'number') {
          sum += column.minWidth;
        } else {
          sum += 150;
        }
      }
    }
    return sum + GRID_BORDER_WIDTH;
  }, [columnDefs, gridProps.rowSelection, gridProps.selectionColumnDef]);

  const suppressHorizontalScroll = gridProps.suppressHorizontalScroll ?? true;
  const effectiveMinWidth = suppressHorizontalScroll
    ? Math.max(initialMinWidth, userResizedWidth)
    : 0;
  const skeletonColumnCount = Array.isArray(columnDefs) ? columnDefs.length : 6;

  return (
    <div
      data-outer-scroll={suppressHorizontalScroll || undefined}
      className={cn(
        'h-full min-h-0 w-full min-w-0 flex-1 overflow-x-auto overflow-y-hidden',
        className,
      )}
    >
      <div
        className="data-grid ag-theme-quartz relative flex h-full min-h-0 w-full min-w-0 flex-1 flex-col overflow-hidden"
        style={{ minWidth: effectiveMinWidth > 0 ? `${effectiveMinWidth}px` : '100%' }}
        role="presentation"
      >
        <AgGridReact
          rowData={filteredRowData}
          columnDefs={effectiveColumnDefs}
          context={gridContext}
          defaultColDef={defaultColDef}
          getRowId={getRowId}
          theme="legacy"
          headerHeight={headerHeight}
          rowHeight={rowHeight}
          suppressCellFocus
          suppressHorizontalScroll={suppressHorizontalScroll}
          tooltipShowDelay={200}
          onRowClicked={onRowClicked}
          onSortChanged={handleSortChanged}
          onBodyScroll={handleBodyScroll}
          onViewportChanged={handleViewportChanged}
          onModelUpdated={handleModelUpdated}
          overlayNoRowsTemplate={emptyMessage}
          {...gridProps}
          onGridReady={onGridReady}
          onColumnResized={(event) => {
            if (event.finished && event.source === 'uiColumnResized') {
              const total =
                event.api
                  .getAllDisplayedColumns()
                  .reduce((sum, col) => sum + col.getActualWidth(), 0) + GRID_BORDER_WIDTH;
              setUserResizedWidth(total);
            }
            gridProps.onColumnResized?.(event);
          }}
        />
        {isLoading ? <DataGridSkeleton columnCount={skeletonColumnCount} /> : null}
        {!isLoading && errorMessage ? <DataGridStatus message={errorMessage} /> : null}
      </div>
    </div>
  );
}

/**
 * 정렬 상태에 따라 목록 하단 등에 노출할 안내 문구를 생성.
 * 사용자가 헤더로 정렬을 바꾸지 않았다면 defaultText를, 바꿨다면 실제 적용된 컬럼과 방향을 반영한 문구를 반환.
 */
export function buildDataGridSortNoteText(sortState, defaultText, columnLabelOverrides = {}) {
  if (!sortState) {
    return defaultText;
  }
  const directionText = sortState.direction === 'desc' ? '내림차순' : '오름차순';
  const columnLabel = columnLabelOverrides[sortState.headerName] ?? sortState.headerName;
  return `${columnLabel} ${directionText}`;
}

/**
 * 반복값 억제용 셀 렌더러를 만든다. 이전 표시 행과 그룹 키가 모두 같으면 빈 셀을 그리고,
 * 그렇지 않으면 원래 렌더러(없으면 AG Grid 기본 표시)를 그대로 쓴다.
 *
 * 다만 화면 맨 위 행은 예외로 값을 다시 보여준다. 스크롤로 그룹 시작 행이 위로 사라진 상태에서도
 * 지금 보이는 행이 누구의 것인지 읽을 수 있어야 하기 때문이다. 이렇게 되살린 값은 그룹이 실제로
 * 시작된 자리가 아니므로 옅은 톤으로 구분한다.
 */
function createSuppressRepeatRenderer(groupKeys, InnerRenderer, anchorRowIndexRef) {
  return function SuppressRepeatCell(params) {
    const isRepeated = isRepeatedFromPreviousRow(params, groupKeys);
    const isAnchorRow = params.node?.rowIndex === anchorRowIndexRef.current;
    if (isRepeated && !isAnchorRow) {
      return null;
    }
    if (InnerRenderer) {
      return <InnerRenderer {...params} />;
    }
    const content = params.valueFormatted ?? params.value ?? '';
    if (isRepeated) {
      return (
        <span className="overflow-hidden font-medium text-ellipsis whitespace-nowrap text-[#94a3b8]">
          {content}
        </span>
      );
    }
    return (
      <span className="max-w-full min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
        {content}
      </span>
    );
  };
}

/**
 * 화면에 보이는 순서 기준으로 바로 위 행과 그룹 키 값이 모두 같은지 확인한다.
 * 원본 배열이 아니라 그리드의 표시 행을 봐야 정렬과 필터 결과에 맞는 판단이 나온다.
 */
function isRepeatedFromPreviousRow(params, groupKeys) {
  const rowIndex = params.node?.rowIndex;
  if (rowIndex == null || rowIndex <= 0 || groupKeys.length === 0) {
    return false;
  }
  const previousNode = params.api.getDisplayedRowAtIndex(rowIndex - 1);
  if (!previousNode?.data) {
    return false;
  }
  return groupKeys.every(
    (colKey) =>
      formatFilterValue(params.api.getCellValue({ rowNode: previousNode, colKey })) ===
      formatFilterValue(params.api.getCellValue({ rowNode: params.node, colKey })),
  );
}

/**
 * 반복값을 되살릴 기준 행(화면 맨 위에 온전히 보이는 행)을 찾는다.
 *
 * getFirstDisplayedRowIndex()는 "보이는 첫 행"이 아니라 "DOM에 렌더된 첫 행"이다. AG Grid가
 * 뷰포트 위아래로 버퍼 행을 미리 그려두기 때문에 그 값을 그대로 쓰면 화면 바깥 행을 가리킨다.
 * 그래서 렌더된 범위를 훑어 스크롤 위치보다 아래에서 시작하는 첫 행을 직접 고른다.
 */
function resolveAnchorRowIndex(api) {
  const rowCount = api.getDisplayedRowCount();
  if (rowCount === 0) {
    return -1;
  }
  const pixelRange = api.getVerticalPixelRange();
  const firstRendered = Math.max(0, api.getFirstDisplayedRowIndex());
  const lastRendered = Math.min(rowCount - 1, api.getLastDisplayedRowIndex());
  for (let index = firstRendered; index <= lastRendered; index += 1) {
    const node = api.getDisplayedRowAtIndex(index);
    // 헤더에 반쯤 가린 행은 글자가 잘리므로 건너뛰고 온전히 보이는 행을 기준으로 삼는다.
    if (node?.rowTop != null && node.rowTop >= pixelRange.top - 1) {
      return index;
    }
  }
  return firstRendered;
}

function DataGridStatus({ message }) {
  return (
    <div className="absolute inset-x-0 top-11 bottom-0 z-2 flex min-h-[210px] items-center justify-center bg-white text-[14px] font-[850] text-[#737b89]">
      {message}
    </div>
  );
}

function DataGridSkeleton({ columnCount }) {
  return (
    <div
      className="absolute inset-x-0 top-11 bottom-0 z-2 flex flex-col overflow-hidden bg-white"
      aria-label="목록 데이터를 불러오는 중입니다."
    >
      {Array.from({ length: 9 }).map((_, rowIndex) => (
        <div
          className="flex min-h-13 items-center gap-4 border-b border-[#efede9] px-3.5"
          key={rowIndex}
        >
          {Array.from({ length: columnCount }).map((_, colIndex) => (
            <span className={cn(tw.skeleton, 'h-3.5 min-w-0 flex-1')} key={colIndex} />
          ))}
        </div>
      ))}
    </div>
  );
}

// 컬럼 필터 값 비교와 표시에 쓰는 문자열 정규화. null/undefined는 빈 값 하나로 묶는다
// (엑셀에서도 빈 셀들이 "(비어 있음)" 하나의 값으로 묶이는 것과 동일).
function formatFilterValue(value) {
  if (value === null || value === undefined) {
    return '';
  }
  return String(value);
}

// 필터 조건 연산자 목록. 값 목록(체크박스) 필터와 별개로, 텍스트 포함이나 숫자 비교로
// 걸러야 할 때 쓴다. 숫자 비교(gte/gt/lte/lt)는 값이 숫자로 변환되지 않으면 매칭 실패로
// 처리한다. 연산자 목록 자체는 columnFilterOperators.js에 둔다(ColumnFilterHeader →
// ColumnFilterPopover → DataGrid로 이어지는 순환 참조를 피하기 위함).
function matchesFilterState(filterState, value) {
  if (filterState.mode === 'condition') {
    return matchesCondition(filterState.op, filterState.value, value);
  }
  // mode === 'values' (기본): 선택된 값 집합에 포함되는지 확인.
  return filterState.selection.has(value);
}

function matchesCondition(op, conditionValue, cellValue) {
  const trimmedCondition = String(conditionValue ?? '').trim();
  if (!trimmedCondition) {
    return true;
  }
  if (op === 'contains') {
    return cellValue.toLowerCase().includes(trimmedCondition.toLowerCase());
  }
  const conditionNumber = Number(trimmedCondition);
  const cellNumber = Number(cellValue);
  if (!Number.isFinite(conditionNumber) || !Number.isFinite(cellNumber)) {
    return false;
  }
  if (op === 'gte') return cellNumber >= conditionNumber;
  if (op === 'gt') return cellNumber > conditionNumber;
  if (op === 'lte') return cellNumber <= conditionNumber;
  if (op === 'lt') return cellNumber < conditionNumber;
  return true;
}
