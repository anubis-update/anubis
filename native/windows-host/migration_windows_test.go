package main

import "testing"

func TestAllowListAction(t *testing.T) {
	base := config{Version: 3, ServiceName: "AnubisHost", InstallDir: `C:\Program Files\Anubis-Security-Tool`, RuntimePath: "anubis.exe"}
	withSids := func(c config, sids ...string) config { c.AllowedSIDs = sids; return c }

	cases := []struct {
		name             string
		existing, incoming config
		want             string
	}{
		{"identical-empty", base, base, "keep"},
		{"identical-populated", withSids(base, "S-1-5-21-1-2-3-500"), withSids(base, "S-1-5-21-1-2-3-500"), "keep"},
		{"empty-to-populated", base, withSids(base, "S-1-5-21-1-2-3-500"), "migrate"},
		{"nil-to-populated", withSids(base), withSids(base, "S-1-5-21-1-2-3-500"), "migrate"},
		{"populated-to-different", withSids(base, "S-1-5-21-1-2-3-500"), withSids(base, "S-1-5-21-1-2-3-501"), "reject"},
		{"populated-to-empty", withSids(base, "S-1-5-21-1-2-3-500"), base, "reject"},
		{"version-mismatch", base, func() config { c := withSids(base, "S-1-5-21-1-2-3-500"); c.Version = 4; return c }(), "reject"},
		{"install-dir-mismatch", base, func() config { c := withSids(base, "S-1-5-21-1-2-3-500"); c.InstallDir = `C:\Other`; return c }(), "reject"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := allowListAction(tc.existing, tc.incoming); got != tc.want {
				t.Fatalf("allowListAction(%s) = %q, want %q", tc.name, got, tc.want)
			}
		})
	}
}
