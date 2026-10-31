param([Parameter(Mandatory=$true)][string]$OutputPath)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$bitmap = New-Object System.Drawing.Bitmap 256, 256
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.Clear([System.Drawing.Color]::Transparent)
$shape = New-Object System.Drawing.Drawing2D.GraphicsPath
foreach ($corner in @(@(8, 8, 180), @(184, 8, 270), @(184, 184, 0), @(8, 184, 90))) {
    $shape.AddArc($corner[0], $corner[1], 64, 64, $corner[2], 90)
}
$shape.CloseFigure()
$green = New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml('#294F46'))
$graphics.FillPath($green, $shape)
$pen = New-Object System.Drawing.Pen ([System.Drawing.ColorTranslator]::FromHtml('#F5F1DE')), 24
$pen.StartCap = $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$graphics.DrawArc($pen, 60, 60, 136, 136, 46, 268)
$gold = New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml('#D8BD79'))
$graphics.FillEllipse($gold, 180, 114, 28, 28)
$bitmap.Save($OutputPath, [System.Drawing.Imaging.ImageFormat]::Png)
$gold.Dispose(); $pen.Dispose(); $green.Dispose(); $shape.Dispose(); $graphics.Dispose(); $bitmap.Dispose()
