import { useTranslation } from "react-i18next";
import { i18n, setLocale } from "../i18n";
import { SettingRow } from "./SettingRows";

export function LanguageSelector() {
  const { t } = useTranslation("language");
  const locale = i18n.resolvedLanguage;
  return (
    <SettingRow title={t("title")} help={t("help")}>
      <div className="seg" role="radiogroup" aria-label={t("title")}>
        <button type="button" role="radio" aria-checked={locale === "en"} className={locale === "en" ? "is-on" : ""} onClick={() => void setLocale("en")}>
          {t("english")}
        </button>
        <button type="button" role="radio" aria-checked={locale === "zh-CN"} className={locale === "zh-CN" ? "is-on" : ""} onClick={() => void setLocale("zh-CN")}>
          {t("simplifiedChinese")}
        </button>
      </div>
    </SettingRow>
  );
}
