const fs = require('fs');
const css = fs.readFileSync('src/app/globals.css', 'utf-8');

let fixed = css.replace(
  /\.results-card > \*:first-child,\n\.details-card > \*:first-child,\n\.search-card > \*:first-child \{/g,
  '.results-card > *:first-child:not(.card-header),\n.details-card > *:first-child:not(.card-header),\n.search-card > *:first-child:not(.card-header) {'
);

fixed = fixed.replace(
  /\.cpt-page \.search-card > \*:first-child,\n\.cpt-page \.results-card > \*:first-child,\n\.cpt-page \.details-card > \*:first-child \{/g,
  '.cpt-page .search-card > *:first-child:not(.card-header),\n.cpt-page .results-card > *:first-child:not(.card-header),\n.cpt-page .details-card > *:first-child:not(.card-header) {'
);

fixed = fixed.replace(
  /\.theme-light \.search-card > \*:first-child,\n\.theme-light \.results-card > \*:first-child,\n\.theme-light \.details-card > \*:first-child \{/g,
  '.theme-light .search-card > *:first-child:not(.card-header),\n.theme-light .results-card > *:first-child:not(.card-header),\n.theme-light .details-card > *:first-child:not(.card-header) {'
);

// We should also ensure the NEXT element after the .card-header gets the top padding.
// Wait, we can just add a new rule for `.card-header + *`.

fs.writeFileSync('src/app/globals.css', fixed);
