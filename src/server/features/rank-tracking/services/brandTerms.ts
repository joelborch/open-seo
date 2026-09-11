import { getDomain } from "tldts";
import { MapsGridRepository } from "@/server/features/maps-grid/repositories/MapsGridRepository";
import { ProjectRepository } from "@/server/features/projects/repositories/ProjectRepository";

/**
 * The registrable label of a host: "theairwaydentists.com" and
 * "blog.theairwaydentists.co.uk" both give "theairwaydentists". The public
 * suffix comes off via tldts rather than a dot count, so "foo.co.uk" doesn't
 * read as the brand "co".
 */
function registrableLabel(domain: string): string {
  const registrable = getDomain(domain) ?? domain;
  return registrable.split(".")[0] ?? "";
}

/**
 * Strings that count as "this brand was named" when an AI Overview's text is
 * checked: the project's own name, its tracked domain's registrable label, and
 * every brand name the project's Maps grid locations were set up with (DBA
 * names, misspellings, legacy brands).
 *
 * Resolved once per rank-check run — the terms are per project, the check is per
 * keyword, and two reads per keyword would be two reads too many. Matching
 * itself is case- and punctuation-insensitive in the parser, so these are
 * passed through as configured.
 */
export async function resolveBrandTerms(input: {
  projectId: string;
  domain: string;
}): Promise<string[]> {
  const [project, locations] = await Promise.all([
    ProjectRepository.getProjectById(input.projectId),
    MapsGridRepository.getLocationsForProject(input.projectId),
  ]);
  const terms = [
    project?.name ?? "",
    registrableLabel(input.domain),
    ...locations.map((location) => location.brandName),
  ];
  return [...new Set(terms.map((term) => term.trim()).filter(Boolean))];
}
