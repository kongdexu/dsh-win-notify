using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32;
using Windows.Data.Xml.Dom;
using Windows.UI.Notifications;

internal static class Native {
  [DllImport("shell32.dll", SetLastError = true)]
  internal static extern void SetCurrentProcessExplicitAppUserModelID(
    [MarshalAs(UnmanagedType.LPWStr)] string AppID);
}

// --- Minimal COM interop to create a Start Menu shortcut with an AUMID ---
[ComImport, Guid("000214F9-0000-0000-C000-000000000046"),
 InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IShellLinkW {
  void GetPath(StringBuilder pszFile, int cch, IntPtr pfd, uint fFlags);
  void GetIDList(out IntPtr ppidl);
  void SetIDList(IntPtr pidl);
  void GetDescription(StringBuilder pszName, int cch);
  void SetDescription(string pszName);
  void GetWorkingDirectory(StringBuilder pszDir, int cch);
  void SetWorkingDirectory(string pszDir);
  void GetArguments(StringBuilder pszArgs, int cch);
  void SetArguments(string pszArgs);
  void GetHotkey(out short pwHotkey);
  void SetHotkey(short wHotkey);
  void GetShowCmd(out int piShowCmd);
  void SetShowCmd(int iShowCmd);
  void GetIconLocation(StringBuilder pszIconPath, int cch, out int piIcon);
  void SetIconLocation(string pszIconPath, int iIcon);
  void SetRelativePath(string pszPathRel, uint dwReserved);
  void Resolve(IntPtr hwnd, uint fFlags);
  void SetPath(string pszFile);
}

[ComImport, Guid("0000010B-0000-0000-C000-000000000046"),
 InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IPersistFile {
  void GetClassID(out Guid pClassID);
  void IsDirty();
  void Load(string pszFileName, uint dwMode);
  void Save(string pszFileName, bool fRemember);
  void SaveCompleted(string pszFileName);
  void GetCurFile(out string ppszFileName);
}

[StructLayout(LayoutKind.Sequential)]
struct PROPERTYKEY {
  public Guid fmtid;
  public uint pid;
}

[StructLayout(LayoutKind.Explicit)]
struct PROPVARIANT {
  [FieldOffset(0)] public ushort vt;
  [FieldOffset(8)] public IntPtr pwszVal;
  public void SetString(string s) {
    vt = 31; // VT_LPWSTR
    if (pwszVal != IntPtr.Zero) Marshal.FreeCoTaskMem(pwszVal);
    pwszVal = Marshal.StringToCoTaskMemUni(s);
  }
  public void Clear() {
    if (pwszVal != IntPtr.Zero) { Marshal.FreeCoTaskMem(pwszVal); pwszVal = IntPtr.Zero; }
    vt = 0;
  }
}

[ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"),
 InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IPropertyStore {
  void GetCount(out uint cProps);
  void GetAt(uint iProp, out PROPERTYKEY pkey);
  void GetValue(ref PROPERTYKEY key, out PROPVARIANT pv);
  void SetValue(ref PROPERTYKEY key, ref PROPVARIANT pv);
  void Commit();
}

internal static class Log {
  private static string path;
  public static void Init(string exeDir) {
    try { path = Path.Combine(exeDir, "dsh-toast.log"); } catch {}
  }
  public static void W(string msg) {
    try { File.AppendAllText(path, msg + "\r\n"); } catch {}
  }
}

internal static class Program {
  private const string APP_ID = "DeepSeekHarness.Notify";
  private const string APP_NAME = "DeepSeek Harness";
  private static readonly PROPERTYKEY PKEY_AUMID = new PROPERTYKEY {
    fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), pid = 5
  };

  private static string EscapeXml(string s) {
    if (string.IsNullOrEmpty(s)) return "";
    return s.Replace("&", "&amp;").Replace("<", "&lt;").Replace(">", "&gt;")
            .Replace("\"", "&quot;").Replace("'", "&apos;");
  }

  private static void EnsureShortcut(string exePath) {
    try {
      string dir = Path.GetDirectoryName(exePath);
      Log.Init(dir);
      string shortcutDir = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
        "Microsoft", "Windows", "Start Menu", "Programs");
      string shortcutPath = Path.Combine(shortcutDir, APP_NAME + ".lnk");
      Log.W("shortcut path: " + shortcutPath);
      Directory.CreateDirectory(shortcutDir);

      Type slType = Type.GetTypeFromCLSID(new Guid("00021401-0000-0000-C000-000000000046"));
      if (slType == null) { Log.W("GetTypeFromCLSID returned null"); return; }
      Log.W("got ShellLink CLSID type");

      object slObj = Activator.CreateInstance(slType);
      if (slObj == null) { Log.W("CreateInstance returned null"); return; }
      Log.W("Activator created slObj, type=" + slObj.GetType().FullName);

      IShellLinkW sl = slObj as IShellLinkW;
      if (sl == null) { Log.W("cast to IShellLinkW failed"); return; }
      Log.W("cast to IShellLinkW OK");

      string iconFile = Path.Combine(dir, "notify.ico");
      sl.SetPath(exePath);
      sl.SetDescription(APP_NAME);
      sl.SetWorkingDirectory(dir);
      sl.SetIconLocation(iconFile, 0);
      Log.W("IShellLink fields set, icon=" + iconFile);

      IPersistFile pf = slObj as IPersistFile;
      if (pf == null) { Log.W("cast to IPersistFile failed"); return; }
      pf.Save(shortcutPath, true);
      Log.W("IPersistFile.Save #1 OK, file exists=" + File.Exists(shortcutPath));

      IPropertyStore ps = slObj as IPropertyStore;
      if (ps == null) { Log.W("cast to IPropertyStore failed"); return; }
      PROPVARIANT v = new PROPVARIANT();
      v.SetString(APP_ID);
      PROPERTYKEY pkey = PKEY_AUMID;
      ps.SetValue(ref pkey, ref v);
      ps.Commit();
      v.Clear();
      Log.W("IPropertyStore SetValue AUMID OK");

      // The AppUserModelID only lands on disk when the link is saved AGAIN
      // after the property Commit; saving before it silently drops the
      // property (verified empirically: lnk read back vt=0). Without the AUMID
      // on the shortcut, Windows cannot resolve this app's notification
      // identity and shows an iconless toast.
      pf.Save(shortcutPath, true);
      Log.W("IPersistFile.Save #2 OK (AUMID persisted)");

      Marshal.ReleaseComObject(ps);
      Marshal.ReleaseComObject(pf);
      Marshal.ReleaseComObject(sl);
      Marshal.ReleaseComObject(slObj);
      Log.W("EnsureShortcut complete");
    } catch (Exception e) {
      Log.W("EXCEPTION: " + e.GetType().Name + ": " + e.Message);
      Log.W("stack: " + e.StackTrace);
    }
  }

  [STAThread]
  private static void Main(string[] args) {
    string exePath = System.Reflection.Assembly.GetExecutingAssembly().Location;
    if (args.Length < 2) return;
    string title = args[0];
    string body = args[1];

    string exeDir = Path.GetDirectoryName(exePath);
    string icoFile = Path.Combine(exeDir, "notify.ico");

    using (var root = Registry.CurrentUser.CreateSubKey(
        @"Software\Classes\AppUserModelId\" + APP_ID)) {
      root.SetValue("DisplayName", APP_NAME, RegistryValueKind.String);
      root.SetValue("IconUri", icoFile, RegistryValueKind.String);
    }
    Native.SetCurrentProcessExplicitAppUserModelID(APP_ID);
    EnsureShortcut(exePath);

    // No <image> in the toast XML on purpose: appLogoOverride renders as a
    // large circle in the notification center. The whale icon instead comes
    // from the AUMID identity (Start Menu shortcut + IconUri registry), which
    // shows at the proper small size next to the title / app name. notify.ico
    // and whale-black-bg.png carry real 16..256px frames for crisp small icons.
    string xml =
      "<toast><visual><binding template='ToastGeneric'>" +
      "<text>" + EscapeXml(title) + "</text>" +
      "<text>" + EscapeXml(body) + "</text>" +
      "</binding></visual></toast>";

    var doc = new XmlDocument();
    doc.LoadXml(xml);
    var toast = new ToastNotification(doc);
    ToastNotificationManager.CreateToastNotifier(APP_ID).Show(toast);
  }
}