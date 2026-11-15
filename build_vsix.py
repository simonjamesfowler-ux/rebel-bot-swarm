"""Build the Rebel Bot Swarm .vsix (a zip with a manifest) without npm or vsce (Han, 15 Nov 2026).
Usage: python build_vsix.py            -> team-panel-<version>.vsix in this folder
Packs the extension files, media/ and docs/."""
import json, os, sys, zipfile
from xml.sax.saxutils import escape

HERE = os.path.dirname(os.path.abspath(__file__))
FILES = ["package.json", "extension.js", "core.js", "README.md", "LICENCE.md", "CHANGELOG.md"]
PAGE = None


def build(here=HERE, files=FILES, page=PAGE, extra=()):
    pkg = json.load(open(os.path.join(here, "package.json"), encoding="utf-8"))
    out = os.path.join(here, f"{pkg['name']}-{pkg['version']}.vsix")
    types = ('<?xml version="1.0" encoding="utf-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
             '<Default Extension=".json" ContentType="application/json"/><Default Extension=".js" ContentType="application/javascript"/>'
             '<Default Extension=".html" ContentType="text/html"/><Default Extension=".md" ContentType="text/markdown"/>'
             '<Default Extension=".txt" ContentType="text/plain"/><Default Extension=".pdf" ContentType="application/pdf"/>'
             '<Default Extension=".svg" ContentType="image/svg+xml"/><Default Extension=".png" ContentType="image/png"/>'
             '<Default Extension=".vsixmanifest" ContentType="text/xml"/></Types>')
    manifest = f'''<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="{escape(pkg['name'])}" Version="{escape(pkg['version'])}" Publisher="{escape(pkg['publisher'])}"/>
    <DisplayName>{escape(pkg['displayName'])}</DisplayName>
    <Description xml:space="preserve">{escape(pkg['description'])}</Description>
    <Tags></Tags>
    <Categories>Other</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <License>extension/LICENCE.md</License>
    <Icon>extension/media/icon.png</Icon>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="{escape(pkg['engines']['vscode'])}"/>
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="ui"/>
    </Properties>
  </Metadata>
  <Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation>
  <Dependencies/>
  <Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/></Assets>
</PackageManifest>'''
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", types)
        z.writestr("extension.vsixmanifest", manifest)
        for f in files:
            z.write(os.path.join(here, f), "extension/" + f)
        if page:
            z.write(page, "extension/media/team_panel.html")
        for src, arc in extra:
            z.write(src, "extension/" + arc)
    return out


if __name__ == "__main__":
    extra = [(os.path.join(HERE, d, f), f"{d}/{f}") for d in ("media", "docs") for f in sorted(os.listdir(os.path.join(HERE, d)))]
    print(build(extra=extra))
