$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

Add-Type -ReferencedAssemblies 'System.Drawing', 'System.Windows.Forms' -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public static class SConnectDesktop
{
    [DllImport("user32.dll")]
    private static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")]
    private static extern void mouse_event(uint flags, uint dx, uint dy, int data, UIntPtr extraInfo);
    [DllImport("user32.dll")]
    private static extern void keybd_event(byte virtualKey, byte scanCode, uint flags, UIntPtr extraInfo);

    public static byte[] Capture(out int left, out int top, out int width, out int height, out int desktopWidth, out int desktopHeight)
    {
        Rectangle bounds = SystemInformation.VirtualScreen;
        left = bounds.Left;
        top = bounds.Top;
        desktopWidth = bounds.Width;
        desktopHeight = bounds.Height;
        width = desktopWidth;
        height = desktopHeight;
        double scale = Math.Min(1.0, Math.Min(1440.0 / Math.Max(1, desktopWidth), 900.0 / Math.Max(1, desktopHeight)));
        int outputWidth = Math.Max(1, (int)(desktopWidth * scale));
        int outputHeight = Math.Max(1, (int)(desktopHeight * scale));
        using (Bitmap source = new Bitmap(width, height))
        using (Graphics graphics = Graphics.FromImage(source))
        using (Bitmap output = new Bitmap(outputWidth, outputHeight))
        using (Graphics resized = Graphics.FromImage(output))
        using (var stream = new System.IO.MemoryStream())
        {
            graphics.CopyFromScreen(bounds.Left, bounds.Top, 0, 0, source.Size);
            resized.InterpolationMode = InterpolationMode.HighQualityBicubic;
            resized.DrawImage(source, 0, 0, outputWidth, outputHeight);
            ImageCodecInfo encoder = Array.Find(ImageCodecInfo.GetImageEncoders(), e => e.MimeType == "image/jpeg");
            using (EncoderParameters parameters = new EncoderParameters(1))
            {
                parameters.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, 55L);
                output.Save(stream, encoder, parameters);
            }
            left = bounds.Left;
            top = bounds.Top;
            width = outputWidth;
            height = outputHeight;
            return stream.ToArray();
        }
    }

    public static void Move(int x, int y) { SetCursorPos(x, y); }
    public static void MouseDown(int button)
    {
        mouse_event((uint)(button == 2 ? 0x0008 : 0x0002), 0, 0, 0, UIntPtr.Zero);
    }
    public static void MouseUp(int button)
    {
        mouse_event((uint)(button == 2 ? 0x0010 : 0x0004), 0, 0, 0, UIntPtr.Zero);
    }
    public static void Wheel(int delta)
    {
        mouse_event(0x0800, 0, 0, delta, UIntPtr.Zero);
    }
    public static void KeyDown(int key) { keybd_event((byte)key, 0, 0, UIntPtr.Zero); }
    public static void KeyUp(int key) { keybd_event((byte)key, 0, 0x0002, UIntPtr.Zero); }
}
'@

while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }

    try {
        $command = $line | ConvertFrom-Json
        switch ($command.type) {
            'capture' {
                $width = 0
                $height = 0
                $left = 0
                $top = 0
                $desktopWidth = 0
                $desktopHeight = 0
                $image = [SConnectDesktop]::Capture([ref]$left, [ref]$top, [ref]$width, [ref]$height, [ref]$desktopWidth, [ref]$desktopHeight)
                $response = @{
                    type = 'frame'
                    left = $left
                    top = $top
                    width = $width
                    height = $height
                    desktopWidth = $desktopWidth
                    desktopHeight = $desktopHeight
                    image = [Convert]::ToBase64String($image)
                }
                [Console]::Out.WriteLine(($response | ConvertTo-Json -Compress))
                [Console]::Out.Flush()
            }
            'move' {
                [SConnectDesktop]::Move([int]$command.x, [int]$command.y)
            }
            'mouseDown' {
                [SConnectDesktop]::MouseDown([int]$command.button)
            }
            'mouseUp' {
                [SConnectDesktop]::MouseUp([int]$command.button)
            }
            'wheel' {
                [SConnectDesktop]::Wheel([int]$command.delta)
            }
            'keyDown' {
                [SConnectDesktop]::KeyDown([int]$command.key)
            }
            'keyUp' {
                [SConnectDesktop]::KeyUp([int]$command.key)
            }
            default {
                throw 'Unsupported remote-control operation.'
            }
        }
    }
    catch {
        $response = @{ type = 'error'; message = $_.Exception.Message }
        [Console]::Out.WriteLine(($response | ConvertTo-Json -Compress))
        [Console]::Out.Flush()
    }
}
