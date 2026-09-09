@echo off
rem docconv - console launcher for the Document Converter CLI.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0docconv.ps1" %*
exit /b %ERRORLEVEL%
