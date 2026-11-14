import type { DockerImage } from "../../api/types";
import { useTranslation } from "react-i18next";
import { Tag } from "../ui/Tag";

/**
 * No registry digest is recorded for the image: it was built (or loaded) on this Spark rather than pulled, so
 * removing it may delete the only copy. Unknown provenance (an older unit program) is not "built here".
 */
export const isBuiltHere = (img: DockerImage) => img.registryDigest === false;

export const BUILT_HERE_TITLE =
  "No registry digest is recorded for this image: it was built or loaded on this Spark, not pulled. Removing it may delete the only copy; it would have to be built again.";

/** The small "Built here, not pulled" mark next to an image. */
export function BuiltHereTag() {
  const { t } = useTranslation("storage");
  return (
    <Tag tone="warn" title={t("docker.builtHere.title")} className="st-built">
      {t("docker.builtHere.label", { })}
    </Tag>
  );
}
