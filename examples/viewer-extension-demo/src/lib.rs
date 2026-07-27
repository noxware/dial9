use dial9_viewer_extension::{Extension, ExtensionError, OutputSink};

dial9_viewer_extension::manifest!(
    r#"
    {
      "version": 1,
      "tables": [],
      "panels": []
    }
    "#
);

#[derive(Default)]
pub struct DemoExtension;

impl Extension for DemoExtension {
    fn finish(self, _output: &mut OutputSink<'_>) -> Result<(), ExtensionError> {
        Ok(())
    }
}

dial9_viewer_extension::export_extension!(DemoExtension);
