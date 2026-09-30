import { describe, expect, it } from "vitest";
import { versionFrom } from "@/core/version";

describe("versionFrom", () => {
  it.each([
    // package.json, git describe -> version, commit
    ["1.0.0", "v1.0.0-0-gabc1234", "1.0.0", "abc1234"],
    ["1.0.0", "v1.0.0-7-gabc1234\n", "1.0.7", "abc1234"],
    ["1.0.0", "v1.0.0-7-gabc1234-dirty", "1.0.7+dirty", "abc1234"],
    // A patch tag, then commits on top.
    ["1.0.0", "v1.0.4-2-gdef5678", "1.0.6", "def5678"],
    // package.json raised past the tag: counts from its own number, never back.
    ["1.1.0", "v1.0.9-3-gabc1234", "1.1.0", "abc1234"],
    ["2.0.0", "v1.4.0-12-gabc1234", "2.0.0", "abc1234"],
    // A patch floor in package.json above the tag's.
    ["1.0.5", "v1.0.0-2-gabc1234", "1.0.7", "abc1234"],
  ])("%s with %j -> %s", (pkg, describe, version, commit) => {
    expect(versionFrom(pkg, describe)).toEqual({ version, commit });
  });

  it.each([
    ["1.0.0", null],
    ["1.0.0", ""],
    ["1.0.0", "abc1234"],               // no tag reachable: describe prints only a hash with --always, fails without
    ["1.0.0", "release-3-gabc1234"],
  ])("without a usable tag the package version stands: %s, %j", (pkg, describe) => {
    expect(versionFrom(pkg, describe)).toEqual({ version: pkg, commit: null });
  });
});
