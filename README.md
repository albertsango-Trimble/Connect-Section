# Cross Section Viewer (Trimble Connect project extension)

Two panes: a map on the left and the Connect 3D viewer on the right. Draw a line on the map and the 3D view clips the models along it and turns to look square-on at the cut.

## Run

```
npm install
npm run dev      # http://localhost:5173 — opens with made-up demo buildings on a blank grid
npm run build    # type-check + production build into dist/
```

## Install in Trimble Connect

Project Settings → Apps & Capabilities → Add Custom, then paste the manifest URL:
`https://albertsango-trimble.github.io/Connect-Section/manifest.json`. GitHub Pages deploys from `main` (`.github/workflows/deploy.yml`).

## How it works

- **Models are loaded automatically.** On start the extension walks the project's folders for model files (IFC, TRB, RVT, DWG, SKP, DGN, NWD and so on) and loads them all into the 3D viewer. **Models** in the toolbar lists them; untick one to leave it out (remembered per project).
- **Object index.** Every object's bounding box is read from the viewer (`src/connect/elementIndex.ts`, up to 200,000 objects) and drawn as faint footprints on the map. It is read again whenever models are loaded or unloaded.
- **Section from the crossed geometry** (`src/core/section.ts`). The line is tested against every footprint. The cut is a vertical plane through the line. The kept slab reaches back as deep as the crossed elements go, and along the line as far as they reach, plus 0.5 m. Site-sized objects (terrain) are still cut but don't set the extent. The depth can be typed in instead of automatic.
- **Clipping** uses four vertical section planes (the cut, the back, and both ends), added through `viewer.addSectionPlane`. Only the planes this extension added are removed.
- **Camera snap.** After every change the 3D camera stands in front of the cut, looking square-on, far enough back to fit the cut in the pane. **Orthographic** switches to a drawing-style view. **Snap to section** puts it back after you orbit.
- **Flip side** looks at the cut from the other side of the line. The blue arrow on the map shows which way the 3D view looks.
- **Linked highlighting.**
  - Map → 3D: hovering over a footprint colours that object in the 3D view. Clicking it selects it there.
  - 3D → map: objects you select or click in the 3D view are highlighted on the map, the picked point is marked, and the 3D camera's position and direction are shown on the map.
- **Base maps** are the same as the 360 viewer: Street, Satellite, WMTS and GeoTIFF (from this computer or read in place from the project).

## Survey data (Trimble JobXML)

- **Survey** in the toolbar lists every JobXML file (`.jxl`) in the project. Tick one to show it, and it's loaded again next time. Files from this computer can be added for the visit.
- Each point takes its best position from the file's `Reductions` section, falling back to the grid position in its `PointRecord`, or WGS84 converted to the project's coordinate system. Deleted points are left out. Grid coordinates are treated as model coordinates.
- **Feature library.** It's chosen automatically: the `.fxl` the job was coded with (`FeatureCodingRecord/SourceFilename`) if it's in the project, otherwise the project's only `.fxl`. It can be changed in the panel or loaded from this computer.
- **Linework** follows the codes the way Trimble Access draws it. Points with the same line or polygon code join in the order they were measured. Control codes after a feature code start, end or close a line, or begin and end an arc or a smooth curve. A trailing number keeps separate strings apart ("EB1", "EB2"). Lines and arcs recorded in the job (`LineRecord`, `ArcRecord`) are drawn too. With no library, a code that's ever followed by a control code is taken as a line, and common control codes (ST, END, CL, BA, EA and so on) are used.
- **On the map:** points and lines in their library colours. Hovering a point shows its name, code, description, coordinates and attributes.
- **In the 3D view:** points as point markups and lines as freeline markups. With a section drawn, only what lies inside it (±0.25 m) is drawn. Points with no height sit at the bottom of the section. The point hovered on the map gets a label in 3D.

## Known gaps and things to verify

- **3D hover can't reach the map.** The Workspace API sends no hover event from the embedded viewer, only clicks (`viewer.onPicked`) and selection changes, so 3D → map highlighting follows the click, not the mouse.
- **Which side a section plane keeps** isn't documented. The code assumes the plane direction points into the part that is kept. If the view shows everything *except* the slab (or nothing), click **Invert clipping** in the 3D pane title; the choice is remembered.
- **Crossing uses bounding boxes.** A diagonal pipe or wall has a box much bigger than its shape, so it can count as crossed when the line passes beside it.
- **Orthographic size.** `orthoSize` is taken as the view height; check it frames the cut.
- **No coordinate system.** If the project has none, or the model isn't in project coordinates, the map is a blank grid in model metres and base maps are greyed out.
- **FXL format.** Trimble doesn't publish the `.fxl` layout, so the reader looks for any element with a code. The element name or its type says point, line, polygon or control code, and colour and layer come from attributes or child elements. Element names it doesn't understand are logged as `[section viewer] feature library elements not understood`. Check one real library.
- **Field Data extension settings.** The library assigned in the Field Data extension's project settings isn't readable through the Connect API. The automatic choice uses the job's own library name, or the project's only `.fxl`.
- **Many models.** Every model in the project is loaded at start. On a large project, untick the ones you don't need under **Models**.

## Layout

- `src/core/section.ts` — crossing test, slab, clipping planes and camera (no Connect calls; easy to test)
- `src/core/mapGeo.ts` — model coordinates ↔ map, through the project CRS or a local grid
- `src/connect/` — Connect connection, project files, model loading, object index
- `src/panes/mapPane.ts` — base maps, footprints, drawing the line, hover
- `src/panes/modelPane.ts` — embedded 3D viewer, section planes, camera, highlighting
- `src/state/store.ts` — shared state between the panes
