import {
  CartesianGrid,
  Line,
  LineChart,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useChartWidth } from "@/client/features/rank-tracking/RankTrackingTrendChart";

/**
 * Visibility score across a config's runs. Only meaningful with at least two
 * runs, so it renders nothing until a grid has been run twice.
 */
export function MapsGridVisibilityTrend({
  points,
}: {
  points: Array<{ startedAt: number; visibility: number | null }>;
}) {
  const { containerRef, width } = useChartWidth();
  if (points.length < 2) return null;

  return (
    <div className="card bg-base-100 border border-base-300">
      <div className="card-body gap-2">
        <h3 className="card-title text-base">Visibility over time</h3>
        <div
          ref={containerRef}
          className="w-full min-w-0"
          style={{ height: 200 }}
        >
          {width > 0 ? (
            <LineChart
              width={width}
              height={200}
              data={points}
              margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
            >
              <CartesianGrid
                strokeDasharray="3 3"
                stroke="currentColor"
                opacity={0.1}
                vertical={false}
              />
              <XAxis
                dataKey="startedAt"
                type="number"
                scale="time"
                domain={["dataMin", "dataMax"]}
                tickFormatter={(value: number) =>
                  new Date(value).toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric",
                  })
                }
                tick={{ fontSize: 10, fill: "#888" }}
                tickLine={false}
                axisLine={false}
                minTickGap={32}
              />
              <YAxis
                domain={[0, 100]}
                tick={{ fontSize: 10, fill: "#888" }}
                tickLine={false}
                axisLine={false}
                width={32}
              />
              <Tooltip
                labelFormatter={(value) =>
                  new Date(Number(value)).toLocaleDateString()
                }
                formatter={(value) => [Number(value).toFixed(0), "Visibility"]}
              />
              <Line
                type="monotone"
                dataKey="visibility"
                stroke="#10b981"
                strokeWidth={2}
                dot={{ r: 2 }}
                connectNulls={false}
                isAnimationActive={false}
              />
            </LineChart>
          ) : null}
        </div>
      </div>
    </div>
  );
}
