import { useId } from "react";
import type { UtilityPart } from "../../data";
import {
  createFigure,
  figureLabels,
  FIGURE_LABELS,
  FIGURE_DESCRIPTIONS,
  PATENT_FIGURES,
  PATENT_DRAWING_STYLE,
  SVG_FRAME,
} from "./drawingModel";
import type { AssemblyModel, Figure } from "./drawingModel";

export function UtilityFigure({ model, parts, figure, title, highlightedComponentIds = [] }: { model: AssemblyModel; parts: UtilityPart[]; figure: Figure; title: string; highlightedComponentIds?: string[] }) {
  const clipId = `model-clip-${useId().replace(/:/g, "")}`;
  const view = createFigure(model, figure);
  const label = FIGURE_LABELS[figure];
  // 实心白填充：按深度从后往前排序（画家算法），遮挡被挡住的虚线，像参考图一样干净
  const solidFaces = view.parts.flatMap(part => part.faces.map(face => ({ ...face, partId: part.source.id })))
    .sort((a, b) => a.depth - b.depth);
  const identity = PATENT_FIGURES.find(item => item.kind === figure)!;
  return (
    <svg
      className="uw-svg"
      xmlns="http://www.w3.org/2000/svg"
      width={SVG_FRAME.width}
      height={SVG_FRAME.height}
      viewBox={`0 0 ${SVG_FRAME.width} ${SVG_FRAME.height}`}
      role="img"
      aria-label={`${PATENT_DRAWING_STYLE.pageTitle} ${label}`}
      data-model-revision={model.revision}
      data-model-parameters={JSON.stringify(model.parameters)}
      data-figure={figure}
      data-figure-id={identity.id}
      data-figure-index={identity.figureIndex}
      data-patent-layout="a4"
      data-reference-style="historical-patent-linework"
    >
      <title>{`${PATENT_DRAWING_STYLE.pageTitle} · ${label} · ${title}`}</title>
      <desc>{FIGURE_DESCRIPTIONS[figure]}当前页面只参考历史附图的版式、黑白线稿和标号方式；产品结构、部件编号与连接关系均依据本次方案重新生成。</desc>
      <metadata>{JSON.stringify({
        title,
        revision: model.revision,
        parameters: model.parameters,
        figure,
        figureLabel: label,
        figureId: identity.id,
        figureIndex: identity.figureIndex,
        pageTitle: PATENT_DRAWING_STYLE.pageTitle,
        pageSize: "A4",
        referenceStyle: "historical-patent-linework",
        sourceBounds: view.sourceBounds,
        scale: view.scale,
        offset: view.offset,
      })}</metadata>

      <rect width={SVG_FRAME.width} height={SVG_FRAME.height} fill="white" />
      <text x={SVG_FRAME.width / 2} y="64" textAnchor="middle" fontSize="24" fontFamily="SimSong, STSong, serif" fill="#111">{PATENT_DRAWING_STYLE.pageTitle}</text>

      <defs><clipPath id={clipId}><rect {...view.clip} /></clipPath></defs>
      {/* 实心白面：先填白遮挡后方轮廓，再画黑边线 */}
      <g clipPath={`url(#${clipId})`} stroke="none">
        {solidFaces.map((face, i) => <polygon
          key={`face-${face.partId}-${i}`}
          points={face.points.map(p => { const q = view.toSheet(p); return `${q[0]},${q[1]}`; }).join(" ")}
          fill="#ffffff"
        />)}
      </g>
      <g clipPath={`url(#${clipId})`} fill="none" stroke="#111" strokeWidth={PATENT_DRAWING_STYLE.geometryStroke} strokeLinejoin="round">
        {view.parts.map(part => <g key={part.source.componentId || part.source.id} data-geometry-part={part.source.id} data-component-id={part.source.componentId} stroke={part.source.componentId && highlightedComponentIds.includes(part.source.componentId) ? '#b45309' : undefined}>
          <title>{`${part.source.referenceNo || parts.find(p => p.componentId === part.source.componentId)?.referenceNo || part.source.id}、${parts.find(p => p.componentId === part.source.componentId)?.name || ""}`}</title>
          <path strokeDasharray={part.source.enclosure ? "5 4" : undefined} d={part.edges.map(([start, end]) => {
            const p = view.toSheet(start), q = view.toSheet(end);
            return `M${p[0]},${p[1]}L${q[0]},${q[1]}`;
          }).join(" ")} />
          {PATENT_DRAWING_STYLE.showHiddenEdges && part.hiddenEdges.length > 0 && (
            <path
              strokeDasharray="4 3"
              strokeWidth={PATENT_DRAWING_STYLE.geometryStroke * 0.85}
              d={part.hiddenEdges.map(([start, end]) => {
                const p = view.toSheet(start), q = view.toSheet(end);
                return `M${p[0]},${p[1]}L${q[0]},${q[1]}`;
              }).join(" ")}
            />
          )}
        </g>)}
      </g>

      <g fontFamily="Arial, SimSong, STSong, sans-serif" fontSize="18" fill="#111">
        {figureLabels(view).map(({ id, componentId, referenceNo, anchor, position, leaderStart }) => {
          // Use patent-facing numeric markers. Stable C IDs stay in metadata
          // and data attributes for consistency checks and traceability.
          const marker = referenceNo || parts.find(part => part.componentId === componentId)?.referenceNo || componentId?.match(/^C(\d+)$/u)?.[1].replace(/^0+(?=\d)/u, "") || String(id);
          return <g className="uw-part-marker" data-part-id={id} data-component-id={componentId} key={componentId || id}>
            <title>{`${marker}、${parts.find(p => p.componentId === componentId)?.name || ""}`}</title>
            <line
              x1={leaderStart[0]}
              y1={leaderStart[1]}
              x2={anchor[0]}
              y2={anchor[1]}
              stroke="#111"
              strokeWidth={PATENT_DRAWING_STYLE.leaderStroke}
            />
            <text x={position[0]} y={position[1]} textAnchor="middle" dominantBaseline="central">{marker}</text>
          </g>;
        })}
      </g>

      <text data-figure-label={label} x={SVG_FRAME.width / 2} y={PATENT_DRAWING_STYLE.figureLabelY} textAnchor="middle" fontFamily="SimSong, STSong, serif" fontSize="22" fill="#111">{label}</text>
    </svg>
  );
}
