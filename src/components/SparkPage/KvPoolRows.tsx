import { useTranslation } from "react-i18next";
import type { KvPoolRatio } from "../../api/types";

export function KvPoolRows({ pools }: { pools: readonly KvPoolRatio[] }) {
  const { t } = useTranslation("hardware");
  return (
    <span className="mt-1 block">
      {pools.map(({ pool, ratio }) => (
        <span className="block" key={pool}>
          {t("history.kvStreamRatio", { pool, percent: Math.round(ratio * 100) })}
        </span>
      ))}
    </span>
  );
}
