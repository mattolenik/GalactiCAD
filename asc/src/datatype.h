//
// datatype.h
// 
// This header file defines the data type of voxel grid and some
// important objects. Moreover, forward declaration of all classes.
//
// Tien-Tsin Wong 1996
//

#ifndef __DATATYPE_H
#define __DATATYPE_H

// Some "char" is not changed to CHAR due to the compiler convention
// of the globally defined function, data. For example, char argv[]
// of the main. Also the name string's "char" is not changed also
#define CHAR      signed char  // Since some compiler's(SGI) default is unsigned char
#define UCHAR   unsigned char  // Explicitly specify the signedness
#define DCHAR            char  // Don't care about the signedness, let the compiler makes decision
#define VOXELDT unsigned char
#if NLEVEL < 7                 // Data type of simple[], ver[] array
#define SIMPLEDT signed char   // the value in these array will not greater
#else                          // than the size of the array, use char only
#define SIMPLEDT signed int    // when N < 7, otherwise overflow don't used
#endif                         // unsigned type, since I used -1 as invalid value

/////////////////// Forward declaration of all classes /////////////////////
class Data;
class Lign;
class Strip;
class Padi;
class DoublyList;
class Farm;
class Slab;
class HighRice;
class Block;


#endif

