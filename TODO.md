# To-do

- [ ] Take mesh export off main thread
- [ ] Exportable benchmark suite, save to file. Also, link to benchmark suite file in
      query string to run the benchmark suite
- [ ] Make benchmark render size same as viewport
- [ ] Camera info in query string so that a specific view distance angle can be linked to
- [ ] By linking to a specific view, we can automate loading various tests/examples and
      then looking at the JS console to see any errors or diagnostic information
- [ ] Replace mesh viewer from dev tools with an export preview window, a modal dialog
      taking up most of the screen. It should have all export options tweakable, and all
      cause re-render when changed. It should be implemented as a web component.
      Its camera should work just like the existing camera, but should not be synced
      back to the SDF preview, the camera changes will be local to the meshviewer in
      the modal dialog of the preview.
- [ ] Object movement and handles
- [ ] Snapping to selections/objects/edges
- [ ] Auto adjust requested buffer allocations
- [ ] SDF debugging plane
