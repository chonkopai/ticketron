"use client";

import type { PublicEvent, PublicVenueLayout, PublicVenueSeat } from "@event-platform/shared-types";
import { hallObjectPaint, hallTextColor, UNAVAILABLE_HALL_COLOR, TARIFF_COLORS } from "@event-platform/shared-types/hall-colors";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { FittedSvgText } from "./fitted-svg-text";
import "./guest-hall-plan.css";

type HallPlanCopy = Record<"hallMap" | "mapZoom" | "zoomIn" | "zoomOut" | "zoomReset" | "available" |
  "row" | "table" | "seat" | "seatSelected" | "seatAvailable" | "seatUnavailable", string>;
type PlanSeat = PublicVenueSeat | PublicVenueLayout["tables"][number]["seatRecords"][number];
type TableOption = Pick<PublicEvent["tables"][number], "id" | "name" | "number" | "saleMode" | "availability">;
type ZoneOption = Pick<PublicEvent["ticketTypes"][number], "id" | "name" | "venueObjectId" | "status" | "remaining">;

interface GuestHallPlanProps {
  layout: PublicVenueLayout;
  copy: HallPlanCopy;
  tableOptions: TableOption[];
  selectedSeatIds: string[];
  selectedTableId: string | null;
  salesAvailable: boolean;
  onSeat: (seat: PlanSeat) => void;
  onTable: (id: string) => void;
  zoneOptions?: ZoneOption[];
  onZone?: (id: string) => void;
  ticketQuantities?: Record<string, number>;
  canSelectSeat?: (id: string) => boolean;
  seatLabels?: Map<string, string>;
  compact?: boolean;
  /** Formats seat prices for the hover tooltip. */
  formatPrice?: (amount: number, currency: string) => string;
  /** Dims every object that does not belong to this tariff (hovering a tariff chip). */
  highlightTariffId?: string | null;
}

export function GuestHallPlan({
  layout, copy, tableOptions, selectedSeatIds, selectedTableId, salesAvailable, onSeat, onTable,
  zoneOptions = [], onZone, ticketQuantities = {}, canSelectSeat, seatLabels, compact = false, formatPrice, highlightTariffId = null,
}: GuestHallPlanProps) {
  const [tip, setTip] = useState<{ x: number; y: number; title: string; sub: string } | null>(null);
  const selected = new Set(selectedSeatIds);
  const json = layout.layoutJson;
  const isV2 = json.version === 2;
  const width = isV2 ? json.room.widthM : json.canvas.width;
  const height = isV2 ? json.room.heightM : json.canvas.height;
  const seatsById = new Map(layout.seats?.map(seat => [seat.id, seat]));
  const tablesById = new Map(tableOptions.map(table => [table.id, table]));
  const zonesByObject = new Map(zoneOptions.map(zone => [zone.venueObjectId, zone]));
  const seatAvailable = (seat: PlanSeat) => salesAvailable && seat.availability === "available" && (canSelectSeat?.(seat.id) ?? true);
  const legacyTariffs = [...layout.tables, ...layout.rows].filter((item, index, all) => all.findIndex(other => other.typeLabel === item.typeLabel && other.price === item.price && other.currency === item.currency) === index).map((item, index) => ({ name: item.typeLabel || copy.available, price: item.price, currency: item.currency, color: TARIFF_COLORS[index % TARIFF_COLORS.length]!.color }));
  const legacyColor = (item: { typeLabel: string | null; price: number | null; currency: string }) => legacyTariffs.find(tariff => tariff.name === (item.typeLabel || copy.available) && tariff.price === item.price && tariff.currency === item.currency)?.color ?? TARIFF_COLORS[0].color;
  const seatCount = layout.seats?.length ?? layout.rows.reduce((total, row) => total + row.seats.length, 0) + layout.tables.reduce((total, table) => total + table.seatRecords.length, 0);
  const initialZoom = seatCount > 300 ? 1.6 : 1;
  const [mapZoom, setMapZoom] = useState(initialZoom);
  const mapViewport = useRef<HTMLDivElement>(null);
  const mapGraphic = useRef<SVGSVGElement>(null);
  const zoomFocus = useRef<{ x: number; y: number; fractionX: number; fractionY: number } | null>(null);
  const requestedZoom = useRef(initialZoom);
  const changeZoom = useCallback((value: number, x?: number, y?: number) => {
    const next = Math.max(.6, Math.min(3, value));
    const bounds = mapGraphic.current?.getBoundingClientRect();
    const viewport = mapViewport.current?.getBoundingClientRect();
    if (next === requestedZoom.current || !bounds?.width || !bounds.height || !viewport) return;
    const focusX = x ?? viewport.left + viewport.width / 2;
    const focusY = y ?? viewport.top + viewport.height / 2;
    zoomFocus.current = { x: focusX, y: focusY, fractionX: (focusX - bounds.left) / bounds.width, fractionY: (focusY - bounds.top) / bounds.height };
    requestedZoom.current = next;
    setMapZoom(next);
  }, []);
  useLayoutEffect(() => {
    const viewport = mapViewport.current;
    const bounds = mapGraphic.current?.getBoundingClientRect();
    if (!viewport || !bounds) return;
    const focus = zoomFocus.current;
    zoomFocus.current = null;
    if (focus) {
      viewport.scrollLeft += bounds.left + bounds.width * focus.fractionX - focus.x;
      viewport.scrollTop += bounds.top + bounds.height * focus.fractionY - focus.y;
    } else if (mapZoom === initialZoom) {
      viewport.scrollLeft = (viewport.scrollWidth - viewport.clientWidth) / 2;
    }
  }, [mapZoom, initialZoom]);
  useEffect(() => {
    const viewport = mapViewport.current;
    if (!viewport) return;
    let pinch: { distance: number; zoom: number } | null = null;
    let gestureZoom: number | null = null;
    const distance = (touches: TouchList) => Math.hypot(touches[0]!.clientX - touches[1]!.clientX, touches[0]!.clientY - touches[1]!.clientY);
    const start = (event: TouchEvent) => { pinch = event.touches.length === 2 ? { distance: distance(event.touches), zoom: requestedZoom.current } : null; };
    const move = (event: TouchEvent) => {
      if (!pinch?.distance || event.touches.length !== 2) return;
      if (event.cancelable) event.preventDefault();
      const [first, second] = [event.touches[0]!, event.touches[1]!];
      changeZoom(pinch.zoom * distance(event.touches) / pinch.distance, (first.clientX + second.clientX) / 2, (first.clientY + second.clientY) / 2);
    };
    const end = (event: TouchEvent) => { if (event.touches.length < 2) pinch = null; };
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      if (gestureZoom !== null || pinch) return;
      const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? viewport.clientHeight : 1;
      changeZoom(requestedZoom.current * Math.exp(-event.deltaY * unit / 200), event.clientX, event.clientY);
    };
    // Safari exposes trackpad pinch as GestureEvents.
    const gestureStart = (event: Event) => { event.preventDefault(); gestureZoom = requestedZoom.current; };
    const gestureChange = (event: Event) => {
      event.preventDefault();
      const { scale, clientX, clientY } = event as MouseEvent & { scale?: number };
      if (gestureZoom !== null && !pinch && scale && Number.isFinite(scale)) changeZoom(gestureZoom * scale, clientX, clientY);
    };
    const gestureEnd = (event: Event) => { event.preventDefault(); gestureZoom = null; };
    viewport.addEventListener("touchstart", start, { passive: true });
    viewport.addEventListener("touchmove", move, { passive: false });
    viewport.addEventListener("touchend", end);
    viewport.addEventListener("touchcancel", end);
    viewport.addEventListener("wheel", wheel, { passive: false });
    viewport.addEventListener("gesturestart", gestureStart);
    viewport.addEventListener("gesturechange", gestureChange);
    viewport.addEventListener("gestureend", gestureEnd);
    return () => {
      viewport.removeEventListener("touchstart", start);
      viewport.removeEventListener("touchmove", move);
      viewport.removeEventListener("touchend", end);
      viewport.removeEventListener("touchcancel", end);
      viewport.removeEventListener("wheel", wheel);
      viewport.removeEventListener("gesturestart", gestureStart);
      viewport.removeEventListener("gesturechange", gestureChange);
      viewport.removeEventListener("gestureend", gestureEnd);
    };
  }, [changeZoom]);
  const showTip = (event: React.PointerEvent<SVGSVGElement>) => {
    const target = (event.target as Element).closest<SVGElement>("[data-tip]");
    if (!target || event.pointerType === "touch") { if (tip) setTip(null); return; }
    const [title = "", sub = ""] = (target.dataset.tip ?? "").split("\n");
    setTip({ x: Math.min(event.clientX + 14, window.innerWidth - 220), y: event.clientY + 16, title, sub });
  };
  const tariffNote = (tariffName: string | undefined, amount: number | null | undefined, currency: string | undefined, available: boolean) =>
    !available ? copy.seatUnavailable : [tariffName, amount != null && currency && formatPrice ? formatPrice(amount, currency) : null].filter(Boolean).join(" · ") || copy.seatAvailable;
  const roomRadius = Math.min(width, height) * .035;
  return <div className="guest-hall"><div aria-label={copy.mapZoom} className="guest-hall-zoom"><button aria-label={copy.zoomOut} disabled={mapZoom <= .6} onClick={() => changeZoom(Math.max(.6, Number((mapZoom - .2).toFixed(1))))} type="button">−</button><button aria-label={copy.zoomReset} className="guest-hall-zoom-value" onClick={() => changeZoom(initialZoom)} type="button">{Math.round(mapZoom * 100)}%</button><button aria-label={copy.zoomIn} disabled={mapZoom >= 3} onClick={() => changeZoom(Math.min(3, Number((mapZoom + .2).toFixed(1))))} type="button">+</button></div><div className="guest-hall-scroll" ref={mapViewport}><svg ref={mapGraphic} aria-label={copy.hallMap} className={`guest-hall-svg${highlightTariffId ? " guest-hall-dimmed" : ""}`} role="group" style={{ width: `${mapZoom * 100}%`, minWidth: `${(compact ? 360 : 620) * mapZoom}px` }} viewBox={`${-width * .02} ${-height * .02} ${width * 1.04} ${height * 1.04}`} onPointerMove={showTip} onPointerLeave={() => setTip(null)}>
        <rect className="guest-hall-floor" x={0} y={0} width={width} height={height} rx={roomRadius} strokeWidth={Math.min(width, height) * .006} />
        {isV2 && json.editor ? [...json.editor.objects].sort((a,b) => a.zIndex - b.zIndex || (a.type === "seat" ? 1 : 0) - (b.type === "seat" ? 1 : 0)).map((object) => {
          const seat = seatsById.get(object.id);
          const paint = hallObjectPaint(object, json.editor!);
          const seatIsPartOfWholeTable = object.type === "seat" && paint.neutral;
          const color = paint.color;
          const tableOption = tablesById.get(object.id);
          const table = tableOption?.saleMode === "whole_table" ? tableOption : undefined;
          const zone = object.type === "zone" ? zonesByObject.get(object.id) : null;
          const interactive = salesAvailable && Boolean(table || zone);
          const available = salesAvailable && (table ? table.availability === "available" : zone ? zone.status === "active" && zone.remaining > 0 : false);
          const active = table ? selectedTableId === table.id : zone ? Boolean((ticketQuantities[zone.id] ?? 0)) : false;
          const activate = () => { if (available) { if (table) onTable(table.id); else if (zone) onZone?.(object.id); } };
          const dimmed = highlightTariffId && paint.tariff?.id !== highlightTariffId && (object.type === "seat" || object.type === "zone" || Boolean(table)) ? " guest-dim" : "";
          const label = table?.name ?? (table ? `${copy.table} ${table.number}` : zone?.name);
          const decorationKind = object.type === "prop" ? (object.builder?.kind === "obstacle" ? "obstacle" : "stage") : object.type === "entrance" ? "entrance" : null;
          const unavailableShape = interactive && !available;
          const shapeFill = unavailableShape ? UNAVAILABLE_HALL_COLOR : active ? "var(--tk-primary, #6320ee)" : paint.neutral ? "var(--tk-surface, #ffffff)" : color;
          const shapeOpacity = unavailableShape || active || paint.neutral ? 1 : object.type === "zone" ? Math.min(.3, Math.max(.14, object.opacity * .3)) : .18;
          const shapeStroke = unavailableShape ? "#9CA3AF" : active ? "var(--tk-primary, #6320ee)" : paint.neutral ? "var(--tk-border, #e4e1ea)" : color;
          const strokeWidth = active ? .08 : .04;
          const dash = object.type === "zone" && !active ? ".22 .18" : undefined;
          const textFill = active ? "#FFFFFF" : "var(--tk-text, #151c27)";
          return <g key={object.id} className={`${table ? "guest-table" : zone ? "guest-zone" : ""}${active ? " is-on" : ""}${dimmed}`} transform={`translate(${object.x} ${object.y}) rotate(${object.rotation})`} {...(interactive ? { role: "button", tabIndex: available ? 0 : -1, "aria-label": `${label} · ${available ? copy.seatAvailable : copy.seatUnavailable}`, "aria-pressed": active, "aria-disabled": !available, onClick: activate, onKeyDown: (key: React.KeyboardEvent<SVGGElement>) => { if (key.key === "Enter" || key.key === " ") { key.preventDefault(); activate(); } }, "data-tip": `${label}\n${available ? paint.tariff?.name ?? copy.seatAvailable : copy.seatUnavailable}`, className: `${table ? "guest-table" : "guest-zone"}${active ? " is-on" : ""}${dimmed} ${available ? "cursor-pointer outline-none" : "cursor-not-allowed"}` } : {})}>
            {interactive ? <title>{`${label} · ${available ? copy.seatAvailable : copy.seatUnavailable}`}</title> : null}
            {object.type === "seat" ? seatIsPartOfWholeTable ? <NeutralSeat number={object.number} size={.225}/> : seat ? <SeatNode cx={0} cy={0} number={seat.number} available={seatAvailable(seat)} selected={selected.has(seat.id)} copy={copy} label={seatLabels?.get(seat.id)} onClick={() => onSeat(seat)} size={.225} tariffColor={color} dimmed={Boolean(dimmed)} tip={tariffNote(paint.tariff?.name, seat.price, seat.currency, seatAvailable(seat))} /> : null
              : decorationKind === "stage" ? <rect className="guest-hall-stage" x={-object.width/2} y={-object.height/2} width={object.width} height={object.height} rx={Math.min(object.width, object.height) * .3} strokeWidth={.04} />
              : decorationKind === "obstacle" ? <rect className="guest-hall-prop" x={-object.width/2} y={-object.height/2} width={object.width} height={object.height} rx={Math.min(object.width, object.height) * .22} fill={object.color} fillOpacity={.28} stroke={object.color} strokeWidth={.03} />
              : decorationKind === "entrance" ? <rect className="guest-hall-entrance" x={-object.width/2} y={-object.height/2} width={object.width} height={object.height} rx={Math.min(object.width, object.height) * .3} strokeWidth={.05} strokeDasharray=".14 .16" />
              : object.type === "zone" ? <polygon className="guest-shape" points={object.points.map((p) => `${p.x},${p.y}`).join(" ")} fill={shapeFill} fillOpacity={shapeOpacity} stroke={shapeStroke} strokeWidth={active ? .08 : .05} strokeDasharray={dash} strokeLinejoin="round" />
              : object.type === "table_round" ? <circle className="guest-shape" r={object.width / 2} fill={shapeFill} fillOpacity={shapeOpacity} stroke={shapeStroke} strokeWidth={strokeWidth} />
              : object.type === "row" ? null
              : <rect className="guest-shape" x={-object.width/2} y={-object.height/2} width={object.width} height={object.height} rx={Math.min(.16, object.height * .3)} fill={shapeFill} fillOpacity={shapeOpacity} stroke={shapeStroke} strokeWidth={strokeWidth} />}
            {object.type === "row" ? <text className="guest-hall-label" textAnchor="middle" dominantBaseline="middle" transform={`translate(${-object.width / 2 - .22} 0) rotate(-90)`} fontSize={.17}>{object.name}</text>
              : decorationKind ? <FittedSvgText text={decorationKind === "entrance" ? `${object.entranceType === "out" ? "←" : object.entranceType === "both" ? "↔" : "→"} ${object.name}` : object.name.toLocaleUpperCase()} maxWidth={object.width * .86} maxHeight={object.height * .6} fontSize={decorationKind === "stage" ? .36 : .26} fontWeight="650" fill={decorationKind === "obstacle" ? "var(--tk-text, #151c27)" : "var(--tk-accent, #6320ee)"} />
              : object.type !== "seat" && <FittedSvgText text={object.name} maxWidth={object.width * (object.type === "table_round" ? .68 : .88)} maxHeight={(object.type === "table_round" ? object.width * .68 : object.height * .7)} fontSize={.24} fontWeight="650" fill={unavailableShape ? "#475569" : textFill} />}
            {zone && !active ? <text className="guest-hall-label" textAnchor="middle" y={Math.min(object.height * .25, .45)} fontSize={.17}>{zone.remaining > 0 ? `${zone.remaining}` : copy.seatUnavailable}</text> : null}
            {zone && active ? <text textAnchor="middle" y={Math.min(object.height * .25, .45)} fontSize={.18} fontWeight="700" fill="#FFFFFF">× {ticketQuantities[zone.id]}</text> : null}
          </g>;
        }) : null}
        {isV2 && !json.editor && json.stage ? <g transform={`rotate(${json.stage.rotation ?? 0} ${json.stage.x + json.stage.width / 2} ${json.stage.y + json.stage.height / 2})`}><rect fill="#151c27" height={json.stage.height} rx="0.25" width={json.stage.width} x={json.stage.x} y={json.stage.y} /><FittedSvgText text={json.stage.label} fill="white" fontSize={.38} fontWeight="700" maxWidth={json.stage.width * .88} maxHeight={json.stage.height * .7} x={json.stage.x + json.stage.width / 2} y={json.stage.y + json.stage.height / 2} /></g> : null}
        {!(isV2 && json.editor) && json.tables.map((geometry) => {
          const table = layout.tables.find((item) => item.id === geometry.tableId);
          if (!table) return null;
          const available = salesAvailable && tablesById.get(table.id)?.availability === "available";
          const color = legacyColor(table);
          const rx = "shape" in geometry && geometry.shape === "round" ? geometry.width / 2 : 0.22;
          const whole = table.saleMode === "whole_table";
          const active = selectedTableId === table.id;
          return <g key={table.id} transform={`rotate(${geometry.rotation ?? 0} ${geometry.x + geometry.width / 2} ${geometry.y + geometry.height / 2})`} {...(whole ? { role: "button", tabIndex: available ? 0 : -1, "aria-label": `${table.name ?? `${copy.table} ${table.number}`} · ${available ? copy.seatAvailable : copy.seatUnavailable}`, "aria-pressed": available && active, "aria-disabled": !available, onClick: () => onTable(table.id), onKeyDown: (key: React.KeyboardEvent<SVGGElement>) => { if (key.key === "Enter" || key.key === " ") { key.preventDefault(); onTable(table.id); } }, className: available ? "cursor-pointer outline-none focus-visible:opacity-70" : "cursor-not-allowed" } : {})}><rect fill={whole ? available ? color : UNAVAILABLE_HALL_COLOR : "white"} height={geometry.height} rx={rx} stroke={active && available ? "#151C27" : whole && available ? color : "#94A3B8"} strokeWidth={isV2 ? active ? 0.1 : 0.06 : active ? 4 : 2} width={geometry.width} x={geometry.x} y={geometry.y} /><FittedSvgText text={table.name ?? `${copy.table} ${table.number}`} fill={whole && available ? hallTextColor(color) : "#151c27"} fontSize={isV2 ? .34 : 16} fontWeight="700" maxWidth={geometry.width * ("shape" in geometry && geometry.shape === "round" ? .68 : .88)} maxHeight={geometry.height * ("shape" in geometry && geometry.shape === "round" ? .68 : .7)} x={geometry.x + geometry.width / 2} y={geometry.y + geometry.height / 2} />{isV2 && "seats" in geometry ? geometry.seats.map((spot) => { const seat = table.seatRecords.find((item) => item.number === spot.number); if (!seat && !whole) return null; const cx = geometry.x + geometry.width * spot.x / 100; const cy = geometry.y + geometry.height * spot.y / 100; return whole ? <g key={spot.number} transform={`translate(${cx} ${cy})`}><NeutralSeat number={spot.number} size={.24}/></g> : seat ? <SeatNode cx={cx} cy={cy} key={seat.id} number={seat.number} available={seatAvailable(seat)} selected={selected.has(seat.id)} copy={copy} label={seatLabels?.get(seat.id)} onClick={() => onSeat(seat)} size={0.24} tariffColor={color} /> : null; }) : null}</g>;
        })}
        {isV2 && !json.editor ? json.rows.map((geometry) => { const row = layout.rows.find((item) => item.id === geometry.rowId); if (!row) return null; return <g key={row.id} transform={`rotate(${geometry.rotation ?? 0} ${geometry.x + geometry.width / 2} ${geometry.y + geometry.height / 2})`}><text fill="var(--ticket-muted)" fontSize="0.18" fontWeight="400" textAnchor="middle" dominantBaseline="middle" transform={`translate(${geometry.x - .22} ${geometry.y + geometry.height / 2}) rotate(-90)`}>{row.name || `${copy.row} ${row.number}`}</text>{row.seats.slice(0, geometry.seatCount).map((seat, index) => <SeatNode cx={geometry.x + (index + 0.5) * geometry.width / geometry.seatCount} cy={geometry.y + geometry.height / 2} key={seat.id} number={seat.number} available={seatAvailable(seat)} selected={selected.has(seat.id)} copy={copy} label={seatLabels?.get(seat.id)} onClick={() => onSeat(seat)} size={0.22} tariffColor={legacyColor(row)} />)}</g>; }) : null}
      </svg></div>{tip ? <div className="guest-hall-tip" style={{ left: tip.x, top: tip.y }}><b>{tip.title}</b>{tip.sub ? <span>{tip.sub}</span> : null}</div> : null}</div>;
}

function NeutralSeat({number,size}:{number:number;size:number}) { return <g aria-hidden="true"><circle r={size} fill="white" stroke="#94A3B8" strokeWidth={size/9}/><text textAnchor="middle" dominantBaseline="central" fontSize={size*.8} fill="#475569">{number}</text></g>; }

function SeatNode({ cx, cy, number, available, selected, onClick, size, tariffColor, copy, label, dimmed = false, tip }: { cx: number; cy: number; number: number; available: boolean; selected: boolean; onClick: () => void; size: number; tariffColor?: string; copy: HallPlanCopy; label?: string | undefined; dimmed?: boolean; tip?: string }) {
  const name = label ?? `${copy.seat} ${number}`;
  const color = tariffColor ?? TARIFF_COLORS[0].color;
  const on = available && selected;
  const state = on ? copy.seatSelected : available ? copy.seatAvailable : copy.seatUnavailable;
  return <g aria-label={`${name}, ${state}`} aria-pressed={on} aria-disabled={!available} className={`guest-seat outline-none${on ? " is-on" : ""}${available ? "" : " is-off"}${dimmed ? " guest-dim" : ""}`} data-tip={`${name}\n${tip ?? state}`} onClick={() => { if (available) onClick(); }} role="button" tabIndex={available ? 0 : -1} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); if (available) onClick(); } }}>
    <title>{`${name} · ${state}`}</title>
    <circle className="guest-seat-focus" cx={cx} cy={cy} fill="none" r={size * 1.4} strokeWidth={size / 6} />
    {on ? <circle className="guest-seat-ring" cx={cx} cy={cy} r={size} fill="none" strokeWidth={size / 5} /> : null}
    <circle cx={cx} cy={cy} fill={available ? color : UNAVAILABLE_HALL_COLOR} r={size} />
    {on ? <circle cx={cx} cy={cy} r={size * .74} fill="var(--tk-primary, #6320ee)" /> : null}
    {on ? <path className="guest-seat-check" d={`M${cx - size * .38} ${cy + size * .02}l${size * .26} ${size * .26} ${size * .5}-${size * .5}`} fill="none" stroke="#FFFFFF" strokeWidth={size * .2} strokeLinecap="round" strokeLinejoin="round" pointerEvents="none" />
      : <text dominantBaseline="central" fill={available ? hallTextColor(color) : "#6B7280"} fontSize={size * .86} fontWeight="650" pointerEvents="none" textAnchor="middle" x={cx} y={cy}>{available ? number : ""}</text>}
  </g>;
}
