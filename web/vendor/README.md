# Vendored Excel reader

`xlsx-0.20.3.full.min.js` is SheetJS Community Edition 0.20.3, copied unmodified from its official release CDN on 2026-10-30. It is loaded from the portal's own origin only inside the GPA import worker. Member files are never sent to SheetJS or another conversion service.

- Source: https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js
- Official installation guidance: https://docs.sheetjs.com/docs/getting-started/installation/standalone/
- Release version confirmed against the official documentation: 0.20.3
- License: Apache-2.0; see `SheetJS-LICENSE.txt`, from https://cdn.sheetjs.com/xlsx-0.20.3/package/LICENSE
- JavaScript SHA-256: `cc015130aa8521e7f088f88898eba949ccdcbfb38df0bd129b44b7273c3a6f41`
- License SHA-256: `4d2a38ac35cda06a555c84074a819d413339cd3691b822cae50f8f322fe01f64`

Do not substitute the older npm `xlsx` release or a runtime CDN request. To update, verify the official release, replace the script and license, update these hashes, and run the Excel parser and GPA import tests.

The importer permits 5 MiB compressed files, 32 worksheets, 1,100 rows and 128 columns per selected worksheet. XLSX archive declarations are limited to 512 entries and 20 MiB expanded content; the worker is terminated after 15 seconds or when the import closes. These limits reduce accidental oversized imports and are not a formal memory sandbox. It reads stored cell values, does not execute formulas/macros or follow workbook links, and marks missing cached formula results as invalid cells.
