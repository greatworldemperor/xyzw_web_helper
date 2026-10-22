@echo off
rem MuMu capture GUI launcher - auto pick a python that has tkinter
setlocal
set "SCRIPT=%~dp0mumu_capture_gui.py"

if not exist "%SCRIPT%" (
  echo [!] mumu_capture_gui.py not found next to this bat.
  pause
  exit /b 1
)

rem 1) py launcher (default python.org install ships tkinter)
where py >nul 2>nul
if not errorlevel 1 (
  py -c "import tkinter" >nul 2>nul
  if not errorlevel 1 (
    start "MuMu Capture" py "%SCRIPT%"
    exit /b 0
  )
)

rem 2) known installs
for %%P in (
  "C:\Python314\python.exe"
  "%USERPROFILE%\AppData\Roaming\uv\python\cpython-3.12.14-windows-x86_64-none\python.exe"
) do (
  if exist %%P (
    %%P -c "import tkinter" >nul 2>nul
    if not errorlevel 1 (
      start "MuMu Capture" %%P "%SCRIPT%"
      exit /b 0
    )
  )
)

rem 3) PATH python
where python >nul 2>nul
if not errorlevel 1 (
  python -c "import tkinter" >nul 2>nul
  if not errorlevel 1 (
    start "MuMu Capture" python "%SCRIPT%"
    exit /b 0
  )
)

echo [!] No Python with tkinter found.
echo     Install python.org Python 3.x ^(defaults include tkinter^), then retry.
pause
exit /b 1
