import clsx from 'clsx';
import { ReactNode, useState } from 'react';
import { Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { formatMoney } from '../lib/format';

// Dark-mode categorical steps from the validated palette, assigned in fixed order.
export const SERIES = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#9085e9', '#e66767'] as const;
const AXIS = '#9d9db2';
const GRID = '#2a2a38';

export const compactMoney = (minor: number) => {
  const r = minor / 100;
  if (r >= 1e7) return `₹${(r / 1e7).toFixed(1)}Cr`;
  if (r >= 1e5) return `₹${(r / 1e5).toFixed(1)}L`;
  if (r >= 1e3) return `₹${(r / 1e3).toFixed(1)}k`;
  return `₹${Math.round(r)}`;
};

interface TipProps {
  active?: boolean;
  payload?: { name?: string; value?: number; color?: string; payload?: Record<string, unknown> }[];
  label?: string;
  money?: boolean;
  unit?: string;
}

function Tip({ active, payload, label, money, unit }: TipProps) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-xl border border-line bg-raised px-3 py-2 text-xs shadow-xl">
      <p className="mb-1 font-medium text-ink">{label ?? payload[0]?.name}</p>
      {payload.map((p) => (
        <p key={p.name} className="flex items-center gap-2 text-muted">
          <span className="h-2 w-2 rounded-sm" style={{ background: p.color }} aria-hidden />
          {p.name}: <span className="font-medium text-ink">{money ? formatMoney(p.value ?? 0) : `${(p.value ?? 0).toLocaleString('en-IN')}${unit ?? ''}`}</span>
        </p>
      ))}
    </div>
  );
}

export function ChartCard({ title, subtitle, empty, children, table }: { title: string; subtitle?: string; empty: boolean; children: ReactNode; table?: { headers: string[]; rows: (string | number)[][] } }) {
  const [asTable, setAsTable] = useState(false);
  return (
    <section className="card p-5" aria-label={title}>
      <div className="mb-4 flex items-start justify-between gap-3">
        <div><h3 className="text-base font-semibold">{title}</h3>{subtitle && <p className="text-xs text-muted">{subtitle}</p>}</div>
        {table && !empty && <button className="rounded-lg px-2 py-1 text-xs text-muted hover:text-ink" onClick={() => setAsTable(!asTable)} aria-pressed={asTable}>{asTable ? 'Chart' : 'Table'}</button>}
      </div>
      {empty ? (
        <div className="flex h-56 items-center justify-center text-sm text-muted">No data for this period.</div>
      ) : asTable && table ? (
        <div className="max-h-64 overflow-auto"><table className="w-full text-left text-xs"><thead className="text-muted"><tr>{table.headers.map((h) => <th key={h} className="py-1 pr-3 font-medium">{h}</th>)}</tr></thead>
          <tbody>{table.rows.map((r, i) => <tr key={i} className="border-t border-line">{r.map((c, j) => <td key={j} className="py-1.5 pr-3">{c}</td>)}</tr>)}</tbody></table></div>
      ) : (
        <div className="h-64 w-full">{children}</div>
      )}
    </section>
  );
}

const shortDay = (d: string) => d.slice(5);
const axisProps = { stroke: AXIS, tick: { fill: AXIS, fontSize: 11 }, tickLine: false, axisLine: { stroke: GRID } } as const;

export function DailyRevenueBars({ data }: { data: { day: string; revenueMinor: number }[] }) {
  return (
    <ResponsiveContainer>
      <BarChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 16 }}>
        <CartesianGrid stroke={GRID} vertical={false} />
        <XAxis dataKey="day" tickFormatter={shortDay} {...axisProps} label={{ value: 'Day', position: 'insideBottom', offset: -10, fill: AXIS, fontSize: 11 }} />
        <YAxis tickFormatter={compactMoney} width={56} {...axisProps} label={{ value: 'Revenue (INR)', angle: -90, position: 'insideLeft', fill: AXIS, fontSize: 11 }} />
        <Tooltip cursor={{ fill: 'rgba(255,255,255,0.04)' }} content={<Tip money />} />
        <Bar dataKey="revenueMinor" name="Revenue" fill={SERIES[0]} radius={[4, 4, 0, 0]} maxBarSize={28} />
      </BarChart>
    </ResponsiveContainer>
  );
}

export function BookingTrendLine({ data, name = 'Bookings', dataKey = 'bookings' }: { data: Record<string, string | number>[]; name?: string; dataKey?: string }) {
  return (
    <ResponsiveContainer>
      <LineChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 16 }}>
        <CartesianGrid stroke={GRID} vertical={false} />
        <XAxis dataKey="day" tickFormatter={shortDay} {...axisProps} label={{ value: 'Day', position: 'insideBottom', offset: -10, fill: AXIS, fontSize: 11 }} />
        <YAxis allowDecimals={false} width={40} {...axisProps} label={{ value: name, angle: -90, position: 'insideLeft', fill: AXIS, fontSize: 11 }} />
        <Tooltip content={<Tip />} />
        <Line type="monotone" dataKey={dataKey} name={name} stroke={SERIES[1]} strokeWidth={2} dot={{ r: 4, fill: SERIES[1], stroke: '#13131a', strokeWidth: 2 }} activeDot={{ r: 6 }} />
      </LineChart>
    </ResponsiveContainer>
  );
}

/** Horizontal ranked bars for a single measure (top movies, top theatres, occupancy by show). */
export function RankedBars({ data, labelKey, valueKey, name, money, unit, color = SERIES[2], axisLabel }: { data: Record<string, string | number>[]; labelKey: string; valueKey: string; name: string; money?: boolean; unit?: string; color?: string; axisLabel: string }) {
  return (
    <ResponsiveContainer>
      <BarChart data={data} layout="vertical" margin={{ top: 4, right: 16, left: 8, bottom: 16 }}>
        <CartesianGrid stroke={GRID} horizontal={false} />
        <XAxis type="number" tickFormatter={money ? compactMoney : undefined} {...axisProps} label={{ value: axisLabel, position: 'insideBottom', offset: -10, fill: AXIS, fontSize: 11 }} />
        <YAxis type="category" dataKey={labelKey} width={110} tickFormatter={(v: string) => (v.length > 16 ? `${v.slice(0, 15)}…` : v)} {...axisProps} />
        <Tooltip cursor={{ fill: 'rgba(255,255,255,0.04)' }} content={<Tip money={money} unit={unit} />} />
        <Bar dataKey={valueKey} name={name} fill={color} radius={[0, 4, 4, 0]} maxBarSize={22} />
      </BarChart>
    </ResponsiveContainer>
  );
}

export function DonutChart({ data, nameKey, valueKey }: { data: Record<string, string | number>[]; nameKey: string; valueKey: string }) {
  return (
    <ResponsiveContainer>
      <PieChart>
        <Pie data={data} dataKey={valueKey} nameKey={nameKey} innerRadius={52} outerRadius={84} paddingAngle={2} stroke="#13131a" strokeWidth={2}>
          {data.map((_, i) => <Cell key={i} fill={SERIES[i % SERIES.length]} />)}
        </Pie>
        <Tooltip content={<Tip />} />
        <Legend verticalAlign="bottom" iconType="square" formatter={(v: string) => <span className="text-xs text-muted">{v}</span>} />
      </PieChart>
    </ResponsiveContainer>
  );
}

export function Kpi({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: 'brand' | 'warn' }) {
  return (
    <div className="card p-5">
      <p className="text-xs uppercase tracking-wide text-muted">{label}</p>
      <p className={clsx('mt-2 font-display text-3xl font-semibold', tone === 'warn' && 'text-warn', tone === 'brand' && 'text-brand')}>{value}</p>
      {hint && <p className="mt-1 text-xs text-muted">{hint}</p>}
    </div>
  );
}
