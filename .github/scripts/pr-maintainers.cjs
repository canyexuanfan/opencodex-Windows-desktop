"use strict";

/**
 * Maintainers from `MAINTAINERS.md` text. Only the current-maintainers table
 * is authoritative; the change log below it can mention retired accounts.
 */
function parseMaintainerLogins(text) {
  const sectionStart = text.indexOf("## Current maintainers");
  const nextHeading = text.indexOf(
    "\n## ",
    sectionStart + "## Current maintainers".length
  );
  const section =
    sectionStart === -1
      ? text
      : text.slice(
          sectionStart,
          nextHeading === -1 ? text.length : nextHeading
        );
  const logins = [
    ...section.matchAll(
      /\[\@([A-Za-z0-9_-]+)\]\(https:\/\/github\.com\/[^)]*\)/g
    )
  ].map(match => match[1]);

  return [...new Set(logins)];
}

module.exports = {
  parseMaintainerLogins
};
