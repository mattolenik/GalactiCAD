# Microsoft Developer Studio Project File - Name="asc" - Package Owner=<4>
# Microsoft Developer Studio Generated Build File, Format Version 6.00
# ** DO NOT EDIT **

# TARGTYPE "Win32 (x86) Console Application" 0x0103

CFG=asc - Win32 asc16
!MESSAGE This is not a valid makefile. To build this project using NMAKE,
!MESSAGE use the Export Makefile command and run
!MESSAGE 
!MESSAGE NMAKE /f "asc.mak".
!MESSAGE 
!MESSAGE You can specify a configuration when running NMAKE
!MESSAGE by defining the macro CFG on the command line. For example:
!MESSAGE 
!MESSAGE NMAKE /f "asc.mak" CFG="asc - Win32 asc16"
!MESSAGE 
!MESSAGE Possible choices for configuration are:
!MESSAGE 
!MESSAGE "asc - Win32 asc1" (based on "Win32 (x86) Console Application")
!MESSAGE "asc - Win32 asc2" (based on "Win32 (x86) Console Application")
!MESSAGE "asc - Win32 asc4" (based on "Win32 (x86) Console Application")
!MESSAGE "asc - Win32 asc8" (based on "Win32 (x86) Console Application")
!MESSAGE 

# Begin Project
# PROP AllowPerConfigDependencies 0
# PROP Scc_ProjName ""
# PROP Scc_LocalPath ""
CPP=cl.exe
RSC=rc.exe

!IF  "$(CFG)" == "asc - Win32 asc1"

# PROP BASE Use_MFC 0
# PROP BASE Use_Debug_Libraries 0
# PROP BASE Output_Dir "asc___Win32_asc1"
# PROP BASE Intermediate_Dir "asc___Win32_asc1"
# PROP BASE Ignore_Export_Lib 0
# PROP BASE Target_Dir ""
# PROP Use_MFC 0
# PROP Use_Debug_Libraries 0
# PROP Output_Dir "../bin"
# PROP Intermediate_Dir "Debug"
# PROP Ignore_Export_Lib 0
# PROP Target_Dir ""
# ADD BASE CPP /nologo /W3 /GX /D "WIN32" /D "NDEBUG" /D "_CONSOLE" /D "_MBCS" /YX /FD /c
# ADD CPP /nologo /W3 /GX /D "WIN32" /D "NDEBUG" /D "_CONSOLE" /D "_MBCS" /D "ASCHEADER1" /YX /FD /c
# ADD BASE RSC /l 0xc04 /d "NDEBUG"
# ADD RSC /l 0xc04 /d "NDEBUG"
BSC32=bscmake.exe
# ADD BASE BSC32 /nologo
# ADD BSC32 /nologo
LINK32=link.exe
# ADD BASE LINK32 kernel32.lib user32.lib gdi32.lib winspool.lib comdlg32.lib advapi32.lib shell32.lib ole32.lib oleaut32.lib uuid.lib odbc32.lib odbccp32.lib /nologo /subsystem:console /machine:I386
# ADD LINK32 kernel32.lib user32.lib gdi32.lib winspool.lib comdlg32.lib advapi32.lib shell32.lib ole32.lib oleaut32.lib uuid.lib odbc32.lib odbccp32.lib /nologo /subsystem:console /machine:I386 /out:"../bin/asc1.exe"

!ELSEIF  "$(CFG)" == "asc - Win32 asc2"

# PROP BASE Use_MFC 0
# PROP BASE Use_Debug_Libraries 0
# PROP BASE Output_Dir "asc___Win32_asc2"
# PROP BASE Intermediate_Dir "asc___Win32_asc2"
# PROP BASE Ignore_Export_Lib 0
# PROP BASE Target_Dir ""
# PROP Use_MFC 0
# PROP Use_Debug_Libraries 0
# PROP Output_Dir "../bin"
# PROP Intermediate_Dir "Debug"
# PROP Ignore_Export_Lib 0
# PROP Target_Dir ""
# ADD BASE CPP /nologo /W3 /GX /D "WIN32" /D "NDEBUG" /D "_CONSOLE" /D "_MBCS" /YX /FD /c
# ADD CPP /nologo /W3 /GX /D "WIN32" /D "NDEBUG" /D "_CONSOLE" /D "_MBCS" /D "ASCHEADER2" /YX /FD /c
# ADD BASE RSC /l 0xc04 /d "NDEBUG"
# ADD RSC /l 0xc04 /d "NDEBUG"
BSC32=bscmake.exe
# ADD BASE BSC32 /nologo
# ADD BSC32 /nologo
LINK32=link.exe
# ADD BASE LINK32 kernel32.lib user32.lib gdi32.lib winspool.lib comdlg32.lib advapi32.lib shell32.lib ole32.lib oleaut32.lib uuid.lib odbc32.lib odbccp32.lib /nologo /subsystem:console /machine:I386
# ADD LINK32 kernel32.lib user32.lib gdi32.lib winspool.lib comdlg32.lib advapi32.lib shell32.lib ole32.lib oleaut32.lib uuid.lib odbc32.lib odbccp32.lib /nologo /subsystem:console /machine:I386 /out:"../bin/asc2.exe"

!ELSEIF  "$(CFG)" == "asc - Win32 asc4"

# PROP BASE Use_MFC 0
# PROP BASE Use_Debug_Libraries 0
# PROP BASE Output_Dir "asc___Win32_asc4"
# PROP BASE Intermediate_Dir "asc___Win32_asc4"
# PROP BASE Ignore_Export_Lib 0
# PROP BASE Target_Dir ""
# PROP Use_MFC 0
# PROP Use_Debug_Libraries 0
# PROP Output_Dir "../bin"
# PROP Intermediate_Dir "Debug"
# PROP Ignore_Export_Lib 0
# PROP Target_Dir ""
# ADD BASE CPP /nologo /W3 /GX /D "WIN32" /D "NDEBUG" /D "_CONSOLE" /D "_MBCS" /YX /FD /c
# ADD CPP /nologo /W3 /GX /D "WIN32" /D "NDEBUG" /D "_CONSOLE" /D "_MBCS" /D "ASCHEADER4" /YX /FD /c
# ADD BASE RSC /l 0xc04 /d "NDEBUG"
# ADD RSC /l 0xc04 /d "NDEBUG"
BSC32=bscmake.exe
# ADD BASE BSC32 /nologo
# ADD BSC32 /nologo
LINK32=link.exe
# ADD BASE LINK32 kernel32.lib user32.lib gdi32.lib winspool.lib comdlg32.lib advapi32.lib shell32.lib ole32.lib oleaut32.lib uuid.lib odbc32.lib odbccp32.lib /nologo /subsystem:console /machine:I386
# ADD LINK32 kernel32.lib user32.lib gdi32.lib winspool.lib comdlg32.lib advapi32.lib shell32.lib ole32.lib oleaut32.lib uuid.lib odbc32.lib odbccp32.lib /nologo /subsystem:console /machine:I386 /out:"../bin/asc4.exe"

!ELSEIF  "$(CFG)" == "asc - Win32 asc8"

# PROP BASE Use_MFC 0
# PROP BASE Use_Debug_Libraries 0
# PROP BASE Output_Dir "asc___Win32_asc8"
# PROP BASE Intermediate_Dir "asc___Win32_asc8"
# PROP BASE Ignore_Export_Lib 0
# PROP BASE Target_Dir ""
# PROP Use_MFC 0
# PROP Use_Debug_Libraries 0
# PROP Output_Dir "../bin"
# PROP Intermediate_Dir "Debug"
# PROP Ignore_Export_Lib 0
# PROP Target_Dir ""
# ADD BASE CPP /nologo /W3 /GX /D "WIN32" /D "NDEBUG" /D "_CONSOLE" /D "_MBCS" /YX /FD /c
# ADD CPP /nologo /W3 /GX /D "WIN32" /D "NDEBUG" /D "_CONSOLE" /D "_MBCS" /D "ASCHEADER8" /YX /FD /c
# ADD BASE RSC /l 0xc04 /d "NDEBUG"
# ADD RSC /l 0xc04 /d "NDEBUG"
BSC32=bscmake.exe
# ADD BASE BSC32 /nologo
# ADD BSC32 /nologo
LINK32=link.exe
# ADD BASE LINK32 kernel32.lib user32.lib gdi32.lib winspool.lib comdlg32.lib advapi32.lib shell32.lib ole32.lib oleaut32.lib uuid.lib odbc32.lib odbccp32.lib /nologo /subsystem:console /machine:I386
# ADD LINK32 kernel32.lib user32.lib gdi32.lib winspool.lib comdlg32.lib advapi32.lib shell32.lib ole32.lib oleaut32.lib uuid.lib odbc32.lib odbccp32.lib /nologo /subsystem:console /machine:I386 /out:"../bin/asc8.exe"

!ENDIF 

# Begin Target

# Name "asc - Win32 asc1"
# Name "asc - Win32 asc2"
# Name "asc - Win32 asc4"
# Name "asc - Win32 asc8"
# Begin Source File

SOURCE=.\asc.cpp
# End Source File
# Begin Source File

SOURCE=.\block.cpp
# End Source File
# Begin Source File

SOURCE=.\common.cpp
# End Source File
# Begin Source File

SOURCE=.\data.cpp
# End Source File
# Begin Source File

SOURCE=.\dikelign.cpp
# End Source File
# Begin Source File

SOURCE=.\doublist.cpp
# End Source File
# Begin Source File

SOURCE=.\farm.cpp
# End Source File
# Begin Source File

SOURCE=.\highrice.cpp
# End Source File
# Begin Source File

SOURCE=.\index.cpp
# End Source File
# Begin Source File

SOURCE=.\initdata.cpp
# End Source File
# Begin Source File

SOURCE=.\kdtree.cpp
# End Source File
# Begin Source File

SOURCE=.\misc.cpp
# End Source File
# Begin Source File

SOURCE=.\padi.cpp
# End Source File
# Begin Source File

SOURCE=.\slab.cpp
# End Source File
# Begin Source File

SOURCE=.\strip.cpp
# End Source File
# Begin Source File

SOURCE=.\vecmath.cpp
# End Source File
# End Target
# End Project
